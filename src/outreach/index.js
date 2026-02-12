/**
 * Outreach Engine — Opener Templates + AI Variations + Staggered Sending
 * Generates unique human-like opener variations per contact
 */

require('dotenv').config();
const OpenAI = require('openai');
const { contacts, conversations, events, settings, queue } = require('../database/db');
const { splitMessage } = require('../humanizer');

let openai = null;
function initOutreach() {
    if (process.env.OPENAI_API_KEY) openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/**
 * Generate multiple unique variations of an opener template
 */
async function generateOpenerVariations(openerTemplate, count = 10, language = 'German') {
    if (!openai) return Array(count).fill(openerTemplate);

    try {
        const res = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{
                role: 'system',
                content: `Du bist ein Experte für WhatsApp-Nachrichten. Erstelle ${count} EINZIGARTIGE Variationen der folgenden Nachricht.

REGELN:
1. Jede Variation muss ANDERS klingen, aber die GLEICHE Bedeutung haben
2. Kurz halten — maximal 1-2 Sätze, unter 150 Zeichen
3. Locker und freundlich, wie eine echte WhatsApp-Nachricht unter Kumpels
4. KEINE Emojis oder nur minimal (max 1)
5. Variiere: Anrede (Hey, Hi, Moin, Servus, etc.), Satzstruktur, Wortauswahl
6. Sprache: ${language}
7. IMMER "du" verwenden, NIEMALS "Sie" — casual und locker
8. KEIN Link, KEIN Pitch, nur die Frage ob Interesse
9. Klingt wie ein Kumpel der eine SMS schreibt, nicht wie ein Verkäufer
10. NIEMALS "Aktivität", "aktiv", "engagiert", "unterwegs" verwenden — M3 ist ein Broadcast-Kanal wo keiner schreiben kann
11. Stattdessen: "ich bin auch bei M3", "du bist ja auch bei M3 dabei", "ich kenn dich aus der M3 Gruppe"
12. EINE zusammenhängende Nachricht, keine Fragmente
Antworte als JSON-Array: ["variation1", "variation2", ...]`
            }, {
                role: 'user',
                content: `Original-Opener: "${openerTemplate}"\n\nErstelle ${count} einzigartige Variationen.`
            }],
            max_tokens: 1500,
            temperature: 0.9
        });

        const content = res.choices[0].message.content.trim();
        // Parse JSON array from response
        const match = content.match(/\[[\s\S]*\]/);
        if (match) {
            const variations = JSON.parse(match[0]);
            return variations.slice(0, count);
        }
        return Array(count).fill(openerTemplate);
    } catch (e) {
        console.error('Opener variation error:', e.message);
        return Array(count).fill(openerTemplate);
    }
}

/**
 * Prepare outreach campaign
 * Returns: { contacts, variations, ready }
 */
async function prepareCampaign(phones, openerTemplate, options = {}) {
    const { batch_id, batch_type, pitch_project, language } = options;
    const batchId = batch_id || `outreach_${Date.now()}`;

    // Generate variations
    const variations = await generateOpenerVariations(openerTemplate, phones.length, language || 'German');

    // Prepare contacts
    const prepared = phones.map((phone, i) => {
        const cleanPhone = phone.replace(/\D/g, '');
        
        // Add/update contact
        contacts.add(cleanPhone, null, null, null, `Outreach batch: ${batchId}`, {
            batch_id: batchId,
            batch_type: batch_type || 'outreach',
            pitch_project: pitch_project || null,
            consent_status: 'UNKNOWN'
        });

        return {
            phone: cleanPhone,
            message: variations[i] || openerTemplate,
            index: i
        };
    });

    return {
        batchId,
        contacts: prepared,
        variations,
        total: prepared.length
    };
}

/**
 * Execute outreach (staggered sending)
 * whatsappClient: the WhatsApp client instance
 * campaign: result from prepareCampaign
 * Returns: results array
 */
async function executeCampaign(whatsappClient, campaign) {
    const results = [];
    const { contacts: targets, batchId } = campaign;

    console.log(`\n🚀 Starting outreach: ${targets.length} contacts (batch: ${batchId})`);

    for (let i = 0; i < targets.length; i++) {
        const target = targets[i];
        const chatId = `${target.phone}@c.us`;

        // Check consent
        const contact = contacts.get(target.phone);
        if (contact?.consent_status === 'DND') {
            console.log(`   ⏭️ [${target.phone}] Skipped — DND`);
            results.push({ phone: target.phone, status: 'skipped', reason: 'DND' });
            continue;
        }

        // Check global kill switch
        if (!settings.isGlobalSendEnabled()) {
            console.log(`   🛑 Global send disabled — stopping outreach`);
            results.push({ phone: target.phone, status: 'stopped', reason: 'kill_switch' });
            break;
        }

        try {
            // Staggered delay: 2-5 minutes between messages
            if (i > 0) {
                const delay = Math.floor(Math.random() * 180000) + 120000;
                console.log(`   ⏳ Waiting ${Math.round(delay/1000)}s...`);
                await new Promise(r => setTimeout(r, delay));
            }

            // Send message
            await whatsappClient.sendMessage(chatId, target.message);
            
            // Log everything
            conversations.add(target.phone, target.message, 'outgoing');
            contacts.updateLastContacted(target.phone);
            contacts.setConsent(target.phone, 'SOFT_OPTIN_SENT');
            events.add(target.phone, 'OUTREACH_SENT', { 
                batch_id: batchId, 
                message: target.message,
                index: i 
            });

            console.log(`   📤 [${i+1}/${targets.length}] ${target.phone}: ${target.message.substring(0, 50)}...`);
            results.push({ phone: target.phone, status: 'sent', message: target.message });

        } catch (e) {
            console.error(`   ❌ [${target.phone}] Error: ${e.message}`);
            events.add(target.phone, 'OUTREACH_ERROR', { error: e.message, batch_id: batchId });
            results.push({ phone: target.phone, status: 'error', error: e.message });
        }
    }

    console.log(`\n✅ Outreach complete: ${results.filter(r => r.status === 'sent').length}/${targets.length} sent`);
    return results;
}

module.exports = { initOutreach, generateOpenerVariations, prepareCampaign, executeCampaign };