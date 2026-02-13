/**
 * Web Dashboard Server
 * Provides a web interface for WhatsApp automation
 */

const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const csv = require('csv-parse/sync');

const QRCode = require('qrcode');
const { contacts, conversations, knowledge, templates, queue, events, settings, initializeDatabase } = require('../database/db');
const { splitMessage, sendHumanLike } = require('../humanizer');
const { killSwitch } = require('../safety');
const { followup, booking, fingerprint } = require('../followup');
const { prepareCampaign, executeCampaign, generateOpenerVariations } = require('../outreach');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Configure multer for file uploads
const upload = multer({ dest: 'uploads/' });

// WhatsApp client reference
let whatsappClient = null;
let isConnected = false;
let currentQR = null;

/**
 * Set WhatsApp client reference
 */
function setWhatsAppClient(client) {
    whatsappClient = client;
    
    client.on('ready', () => {
        isConnected = true;
        currentQR = null;
    });
    
    client.on('disconnected', () => {
        isConnected = false;
    });
}

/**
 * Set QR code for display
 */
function setQRCode(qr) {
    currentQR = qr;
}

// ============== API ROUTES ==============

// Status
app.get('/api/status', (req, res) => {
    let myNumber = null;
    try { if (whatsappClient && whatsappClient.info) myNumber = whatsappClient.info.wid.user; } catch(e) {}
    res.json({
        connected: isConnected,
        qr: currentQR,
        myNumber,
        timestamp: new Date().toISOString()
    });
});

// Disconnect WhatsApp
app.post('/api/disconnect', async (req, res) => {
    try {
        if (whatsappClient) {
            await whatsappClient.logout();
            isConnected = false;
            currentQR = null;
        }
        res.json({ success: true, message: 'Disconnected' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Reconnect WhatsApp (triggers new QR)
app.post('/api/reconnect', async (req, res) => {
    try {
        if (whatsappClient) {
            try { await whatsappClient.destroy(); } catch(e) {}
        }
        isConnected = false;
        currentQR = null;
        // Signal to main process to reinitialize
        if (global.reinitializeClient) {
            global.reinitializeClient();
        }
        res.json({ success: true, message: 'Reconnecting — scan new QR code' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// QR Code endpoint - returns data URL image
app.get('/api/qr', async (req, res) => {
    if (isConnected) {
        return res.json({ connected: true, qrImage: null });
    }
    if (currentQR) {
        try {
            const qrImage = await QRCode.toDataURL(currentQR, {
                width: 300,
                margin: 2,
                color: { dark: '#000000', light: '#ffffff' }
            });
            return res.json({ connected: false, qrImage: qrImage });
        } catch (e) {
            return res.json({ connected: false, qrImage: null, error: e.message });
        }
    }
    res.json({ connected: false, qrImage: null });
});

// ============== CONTACTS ==============

// Get all contacts
app.get('/api/contacts', (req, res) => {
    try {
        const allContacts = contacts.getAll();
        res.json({ success: true, contacts: allContacts });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Default opener template for auto-outreach
const DEFAULT_OPENER = "Hey, ich hab deine Nummer aus der M3 Gruppe, bist du auch im Blockchain-Bereich unterwegs?";

// Add contact — auto-starts outreach
app.post('/api/contacts', async (req, res) => {
    try {
        const { phone, name, company, email, notes } = req.body;
        const cleanPhone = phone.replace(/\D/g, '');
        contacts.add(cleanPhone, name, company, email, notes);
        
        // Auto-start outreach if WhatsApp connected and no prior conversation
        const existing = conversations.getByPhone(cleanPhone);
        if (whatsappClient && isConnected && existing.length === 0) {
            const campaign = await prepareCampaign([cleanPhone], DEFAULT_OPENER, { batch_type: 'auto' });
            res.json({ success: true, message: 'Contact added + outreach started' });
            executeCampaign(whatsappClient, campaign).catch(e => console.error('Auto-outreach error:', e));
        } else {
            res.json({ success: true, message: 'Contact added' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Upload contacts CSV
app.post('/api/contacts/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, error: 'No file uploaded' });
        }

        const fileContent = require('fs').readFileSync(req.file.path, 'utf-8');
        const records = csv.parse(fileContent, {
            columns: true,
            skip_empty_lines: true
        });

        let added = 0;
        records.forEach(record => {
            const phone = record.phone || record.Phone || record.number || record.Number;
            const name = record.name || record.Name || record.first_name || null;
            const company = record.company || record.Company || record.organization || null;
            const email = record.email || record.Email || null;
            
            if (phone) {
                contacts.add(phone.replace(/\D/g, ''), name, company, email);
                added++;
            }
        });

        // Clean up uploaded file
        require('fs').unlinkSync(req.file.path);

        res.json({ success: true, message: `Added ${added} contacts`, total: added });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update contact
app.put('/api/contacts/:phone', (req, res) => {
    try {
        const { phone } = req.params;
        const updates = req.body;
        contacts.update(phone, updates);
        res.json({ success: true, message: 'Contact updated' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============== MESSAGES ==============

// Send message
app.post('/api/messages/send', async (req, res) => {
    try {
        const { phone, message } = req.body;
        
        if (!whatsappClient || !isConnected) {
            return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
        }

        const chatId = `${phone}@c.us`;
        
        // Send with human-like behavior
        await sendHumanLike(whatsappClient, chatId, message);
        
        // Save to conversations
        conversations.add(phone, message, 'outgoing');
        contacts.updateLastContacted(phone);
        
        res.json({ success: true, message: 'Message sent' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get conversations
app.get('/api/conversations/:phone', (req, res) => {
    try {
        const { phone } = req.params;
        const history = conversations.getByPhone(phone);
        res.json({ success: true, conversations: history });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============== KNOWLEDGE BASE ==============

// Get all knowledge
app.get('/api/knowledge', (req, res) => {
    try {
        const allKnowledge = knowledge.getAll();
        res.json({ success: true, knowledge: allKnowledge });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Add knowledge
app.post('/api/knowledge', (req, res) => {
    try {
        const { category, answer, question, keywords } = req.body;
        knowledge.add(category, answer, question, keywords);
        res.json({ success: true, message: 'Knowledge added' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete knowledge
app.delete('/api/knowledge/:id', (req, res) => {
    try {
        const { id } = req.params;
        knowledge.delete(parseInt(id));
        res.json({ success: true, message: 'Knowledge deleted' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============== TEMPLATES ==============

// Get all templates
app.get('/api/templates', (req, res) => {
    try {
        const allTemplates = templates.getAll();
        res.json({ success: true, templates: allTemplates });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Add template
app.post('/api/templates', (req, res) => {
    try {
        const { name, content } = req.body;
        templates.add(name, content);
        res.json({ success: true, message: 'Template added' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============== PIPELINE ==============

// Get pipeline stats (contacts by stage)
app.get('/api/pipeline', (req, res) => {
    try {
        const stages = ['INTRO','QUALIFYING','VALUE_DELIVERY','BOOKING','FOLLOW_UP','WON','LOST','DND'];
        const pipeline = {};
        stages.forEach(s => { pipeline[s] = contacts.getByStage(s); });
        res.json({ success: true, pipeline });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Get CCB for a contact
app.get('/api/contacts/:phone/ccb', (req, res) => {
    try {
        const ccb = contacts.getCCB(req.params.phone);
        const contact = contacts.get(req.params.phone);
        res.json({ success: true, ccb, contact });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== EVENTS ==============

app.get('/api/events', (req, res) => {
    try {
        const recent = events.getRecent(100);
        res.json({ success: true, events: recent });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/events/:phone', (req, res) => {
    try {
        const phoneEvents = events.getByPhone(req.params.phone, 50);
        res.json({ success: true, events: phoneEvents });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== SETTINGS / KILL SWITCH ==============

app.get('/api/settings', (req, res) => {
    try {
        const all = settings.getAll();
        res.json({ success: true, settings: all, globalSendEnabled: settings.isGlobalSendEnabled(), autoReplyEnabled: settings.isAutoReplyEnabled() });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/settings', (req, res) => {
    try {
        const { key, value } = req.body;
        settings.set(key, value);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/kill-switch/stop', (req, res) => {
    killSwitch.emergencyStop();
    res.json({ success: true, message: 'EMERGENCY STOP activated' });
});

app.post('/api/kill-switch/resume', (req, res) => {
    killSwitch.resume();
    res.json({ success: true, message: 'Sending resumed' });
});

// ============== HUMAN TAKEOVER ==============

app.post('/api/contacts/:phone/takeover', (req, res) => {
    try {
        contacts.pauseBot(req.params.phone);
        contacts.setHumanRequired(req.params.phone, true);
        res.json({ success: true, message: 'Bot paused — human takeover active' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/contacts/:phone/resume-bot', (req, res) => {
    try {
        contacts.resumeBot(req.params.phone);
        contacts.setHumanRequired(req.params.phone, false);
        res.json({ success: true, message: 'Bot resumed' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/contacts/:phone/dnd', (req, res) => {
    try {
        contacts.setDND(req.params.phone);
        res.json({ success: true, message: 'Contact set to DND' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Get contacts needing human attention
app.get('/api/human-required', (req, res) => {
    try {
        const list = contacts.getHumanRequired();
        res.json({ success: true, contacts: list });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== BATCH IMPORT ==============

app.post('/api/contacts/batch-upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ success: false, error: 'No file' });
        const { batch_id, batch_type, pitch_project } = req.body;

        const fileContent = require('fs').readFileSync(req.file.path, 'utf-8');
        const records = csv.parse(fileContent, { columns: true, skip_empty_lines: true });

        let added = 0;
        records.forEach(r => {
            const phone = (r.phone || r.Phone || r.number || r.Number || '').replace(/\D/g, '');
            if (phone) {
                contacts.add(phone, r.name || r.Name || null, r.company || r.Company || null, r.email || r.Email || null, null, {
                    batch_id: batch_id || `batch_${Date.now()}`,
                    batch_type: batch_type || 'import',
                    pitch_project: pitch_project || null,
                    consent_status: 'UNKNOWN'
                });
                added++;
            }
        });
        require('fs').unlinkSync(req.file.path);
        res.json({ success: true, message: `Imported ${added} contacts`, total: added, batch_id });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== FOLLOW-UP & BOOKING ==============

app.get('/api/followups', (req, res) => {
    try {
        const eligible = followup.checkAll();
        res.json({ success: true, followups: eligible.map(f => ({
            phone: f.contact.phone, name: f.contact.name, stage: f.contact.pipeline_stage,
            type: f.type, messageType: f.messageType, hoursAgo: f.hoursAgo
        }))});
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/followups/queue-all', (req, res) => {
    try {
        const result = followup.queueAll();
        res.json({ success: true, ...result });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/contacts/:phone/booking-offer', (req, res) => {
    try {
        const contact = contacts.get(req.params.phone);
        if (!contact) return res.status(404).json({ success: false, error: 'Contact not found' });
        const offer = booking.offerSlots(contact);
        res.json({ success: true, ...offer });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/api/contacts/:phone/book', (req, res) => {
    try {
        const { slot } = req.body;
        const result = booking.confirm(req.params.phone, slot);
        res.json({ success: true, ...result });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/api/queue', (req, res) => {
    try {
        const pending = queue.getPending();
        res.json({ success: true, queue: pending });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== OUTREACH ==============

// Preview opener variations (without sending)
app.post('/api/outreach/preview', async (req, res) => {
    try {
        const { opener, count, language } = req.body;
        if (!opener) return res.status(400).json({ success: false, error: 'Opener template required' });
        const variations = await generateOpenerVariations(opener, count || 5, language || 'German');
        res.json({ success: true, variations });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Prepare + execute outreach campaign
app.post('/api/outreach/start', async (req, res) => {
    try {
        const { phones, opener, batch_type, pitch_project, language } = req.body;
        if (!phones?.length || !opener) return res.status(400).json({ success: false, error: 'phones[] and opener required' });
        if (!whatsappClient || !isConnected) return res.status(400).json({ success: false, error: 'WhatsApp not connected' });

        // Prepare campaign
        const campaign = await prepareCampaign(phones, opener, { batch_type, pitch_project, language });
        
        // Return preview immediately, execute in background
        res.json({ success: true, message: `Outreach started for ${campaign.total} contacts`, batchId: campaign.batchId, preview: campaign.contacts });

        // Execute staggered sending in background
        executeCampaign(whatsappClient, campaign).catch(e => console.error('Outreach error:', e));

    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== FETCH WHATSAPP CHAT (live from WA) ==============

app.get('/api/whatsapp-chat/:phone', async (req, res) => {
    try {
        if (!whatsappClient || !isConnected) return res.status(400).json({ success: false, error: 'WhatsApp not connected' });
        const phone = req.params.phone;
        const chatId = `${phone}@c.us`;
        const chat = await whatsappClient.getChatById(chatId).catch(() => null);
        if (!chat) return res.json({ success: false, error: 'Chat not found' });
        const messages = await chat.fetchMessages({ limit: 20 });
        const parsed = messages.map(m => ({
            from: m.fromMe ? 'me' : phone,
            body: m.body,
            timestamp: m.timestamp,
            time: new Date(m.timestamp * 1000).toISOString(),
            fromMe: m.fromMe,
            type: m.type
        }));
        res.json({ success: true, messages: parsed });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== SAVE CONTACT TO PHONE ==============

app.post('/api/save-contact', async (req, res) => {
    try {
        if (!whatsappClient || !isConnected) return res.status(400).json({ success: false, error: 'Not connected' });
        const { phone, name } = req.body;
        const jid = `${phone}@c.us`;
        
        // Use WhatsApp Web's internal saveContactAction
        const result = await whatsappClient.pupPage.evaluate(async (jid, firstName, lastName) => {
            try {
                const utils = window.Store.AddressbookContactUtils;
                if (!utils || !utils.saveContactAction) {
                    return { success: false, error: 'saveContactAction not available' };
                }
                
                // Get the contact
                const contact = window.Store.Contact.get(jid);
                if (!contact) return { success: false, error: 'Contact not found' };
                
                const attempts = [];
                
                // Create proper WID using WidFactory
                let properWid = contact.id;
                if (window.Store.WidFactory && window.Store.WidFactory.createWid) {
                    try {
                        properWid = window.Store.WidFactory.createWid(jid);
                    } catch(e) { attempts.push('WidFactory: ' + e.message); }
                }
                
                // Try saveContactAction - it likely takes (wid, firstName, lastName)
                try {
                    const r = await utils.saveContactAction(properWid, firstName, lastName || '');
                    return { success: true, method: 'saveContactAction(properWid)', result: JSON.stringify(r) };
                } catch(e) { attempts.push('action(wid,f,l): ' + e.message); }
                
                // Try as object: {wid, firstName, lastName}
                try {
                    const r = await utils.saveContactAction({wid: properWid, firstName, lastName: lastName || ''});
                    return { success: true, method: 'saveContactAction({wid})' };
                } catch(e) { attempts.push('action({wid}): ' + e.message); }
                
                // Try batch with proper wid
                try {
                    const r = await utils.saveContactBatchAction([{wid: properWid, firstName, lastName: lastName || ''}]);
                    return { success: true, method: 'batch({wid})' };
                } catch(e) { attempts.push('batch({wid}): ' + e.message); }
                
                // Try using contact.updateName directly
                try {
                    contact.updateName(firstName + ' ' + (lastName || ''));
                    return { success: true, method: 'contact.updateName' };
                } catch(e) { attempts.push('updateName: ' + e.message); }
                
                // Check WidFactory methods
                let widFactoryMethods = [];
                if (window.Store.WidFactory) {
                    widFactoryMethods = Object.getOwnPropertyNames(window.Store.WidFactory).filter(k => typeof window.Store.WidFactory[k] === 'function');
                }
                
                return { success: false, attempts, widFactoryMethods };
            } catch (e) {
                return { success: false, error: e.message };
            }
        }, jid, name.split(' ')[0], name.split(' ').slice(1).join(' '));
        
        res.json({ success: result.success, result });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== SEND VCARD ==============

app.post('/api/send-vcard', async (req, res) => {
    try {
        if (!whatsappClient || !isConnected) return res.status(400).json({ success: false, error: 'Not connected' });
        const { targetPhone, contactPhone, contactName } = req.body;
        const chatId = `${targetPhone}@c.us`;
        const vcard = `BEGIN:VCARD\nVERSION:3.0\nFN:${contactName}\nTEL;type=CELL;type=VOICE:+${contactPhone}\nEND:VCARD`;
        await whatsappClient.sendMessage(chatId, vcard, { parseVCards: true });
        res.json({ success: true, message: `vCard ${contactName} sent` });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== CONTACT DETAILS (from WhatsApp) ==============

app.get('/api/whatsapp-contact/:phone', async (req, res) => {
    try {
        if (!whatsappClient || !isConnected) return res.status(400).json({ success: false, error: 'Not connected' });
        const phone = req.params.phone;
        const chatId = `${phone}@c.us`;
        const contact = await whatsappClient.getContactById(chatId).catch(() => null);
        if (!contact) return res.json({ success: false, error: 'Contact not found' });
        res.json({
            success: true,
            phone,
            pushname: contact.pushname || null,
            name: contact.name || null,
            shortName: contact.shortName || null,
            number: contact.number || phone,
            isMyContact: contact.isMyContact || false,
            about: null // Can't reliably get about via API
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== PROFILE PICTURE ==============

app.get('/api/contacts/:phone/pfp', async (req, res) => {
    try {
        if (!whatsappClient || !isConnected) return res.json({ success: false, pfp: null });
        const chatId = `${req.params.phone}@c.us`;
        const url = await whatsappClient.getProfilePicUrl(chatId).catch(() => null);
        res.json({ success: true, pfp: url || null });
    } catch (e) { res.json({ success: false, pfp: null }); }
});

// ============== BULK ADD (comma-separated) ==============

app.post('/api/contacts/bulk-add', async (req, res) => {
    try {
        const { phones, batch_type, pitch_project } = req.body;
        if (!phones) return res.status(400).json({ success: false, error: 'No phones provided' });
        const phoneList = phones.split(',').map(p => p.trim().replace(/\D/g, '')).filter(p => p.length > 5);
        
        // Filter to only new contacts (no prior conversations)
        const newPhones = [];
        phoneList.forEach(phone => {
            contacts.add(phone, null, null, null, null, {
                batch_type: batch_type || 'manual',
                pitch_project: pitch_project || null,
                consent_status: 'UNKNOWN'
            });
            const existing = conversations.getByPhone(phone);
            if (existing.length === 0) newPhones.push(phone);
        });

        // Auto-start outreach for new contacts
        if (whatsappClient && isConnected && newPhones.length > 0) {
            const campaign = await prepareCampaign(newPhones, DEFAULT_OPENER, { batch_type: batch_type || 'manual' });
            res.json({ success: true, message: `Added ${phoneList.length} contacts, outreach started for ${newPhones.length}`, total: phoneList.length, outreachStarted: newPhones.length });
            executeCampaign(whatsappClient, campaign).catch(e => console.error('Bulk outreach error:', e));
        } else {
            res.json({ success: true, message: `Added ${phoneList.length} contacts`, total: phoneList.length, phones: phoneList });
        }
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== KPI STATS ==============

app.get('/api/kpis', (req, res) => {
    try {
        const allContacts = contacts.getAll();
        const totalContacts = allContacts.length;
        const byStage = {};
        const byConsent = {};
        allContacts.forEach(c => {
            byStage[c.pipeline_stage] = (byStage[c.pipeline_stage] || 0) + 1;
            byConsent[c.consent_status] = (byConsent[c.consent_status] || 0) + 1;
        });
        const humanRequired = contacts.getHumanRequired().length;
        const recentEvents = events.getRecent(200);
        const outbound = recentEvents.filter(e => e.event_type === 'OUTBOUND_MESSAGE').length;
        const inbound = recentEvents.filter(e => e.event_type === 'INBOUND_MESSAGE').length;
        const escalations = recentEvents.filter(e => e.event_type === 'ESCALATION_TRIGGERED').length;
        const blocked = recentEvents.filter(e => e.event_type === 'SEND_BLOCKED' || e.event_type === 'VALIDATION_FAILED').length;

        res.json({
            success: true,
            kpis: {
                totalContacts, byStage, byConsent, humanRequired,
                messagesSent: outbound, messagesReceived: inbound,
                escalations, blocked,
                globalSendEnabled: settings.isGlobalSendEnabled(),
                autoReplyEnabled: settings.isAutoReplyEnabled()
            }
        });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ============== START SERVER ==============

function startServer() {
    app.listen(PORT, () => {
        console.log(`🌐 Dashboard running at http://localhost:${PORT}`);
    });
}

module.exports = { startServer, setWhatsAppClient, setQRCode, app };
