/**
 * Web Dashboard Server
 * Provides a web interface for WhatsApp automation
 */

const express = require('express');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const csv = require('csv-parse/sync');

const { contacts, conversations, knowledge, templates, queue, initializeDatabase } = require('../database/db');
const { splitMessage, sendHumanLike } = require('../humanizer');

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
    res.json({
        connected: isConnected,
        qr: currentQR,
        timestamp: new Date().toISOString()
    });
});

// QR Code endpoint
app.get('/api/qr', (req, res) => {
    res.json({
        qr: currentQR,
        connected: isConnected
    });
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

// Add contact
app.post('/api/contacts', (req, res) => {
    try {
        const { phone, name, company, email, notes } = req.body;
        contacts.add(phone, name, company, email, notes);
        res.json({ success: true, message: 'Contact added' });
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

// ============== START SERVER ==============

function startServer() {
    app.listen(PORT, () => {
        console.log(`🌐 Dashboard running at http://localhost:${PORT}`);
    });
}

module.exports = { startServer, setWhatsAppClient, setQRCode, app };
