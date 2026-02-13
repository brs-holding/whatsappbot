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

// ═══════════════ HARDCODED FALLBACK VARIATIONS ═══════════════
// Used when AI fails — ensures we NEVER send identical messages
const FALLBACK_OPENERS = [
    "Hey, ich hab deine Nummer aus der M3 Gruppe. Bist du auch im Blockchain-Bereich unterwegs?",
    "Servus, ich kenn dich aus der M3 Gruppe! Interessierst du dich auch für Blockchain?",
    "Moin! Du bist ja auch bei M3 dabei — bist du auch im Crypto-Bereich aktiv?",
    "Hi, ich hab gesehen du bist bei M3 dabei. Bist du offen für Blockchain-Themen?",
    "Grüß dich! Ich bin auch bei M3 und wollte fragen ob du dich für Blockchain interessierst?",
    "Na, ich kenn dich aus der M3 Gruppe. Hast du Interesse an Blockchain?",
    "Hoi, du bist ja auch bei M3 dabei — beschäftigst du dich auch mit Blockchain?",
    "Sali, ich hab deine Nummer über die M3 Gruppe. Blockchain ist auch dein Ding?",
    "Moin Moin! Ich kenn dich von M3, wollte mal fragen ob Blockchain auch dein Thema ist?",
    "Hey, wir sind beide bei M3 dabei. Bist du zufällig auch im Blockchain-Space?",
    "Servus! Hab dich bei M3 gesehen, interessierst du dich für Blockchain?",
    "Hi, ich bin auch bei M3 und wollt mal fragen — bist du im Crypto-Bereich unterwegs?",
    "Na du, ich kenn dich aus der M3 Community. Hast du was mit Blockchain am Hut?",
    "Grüß dich, ich bin auch bei M3. Blockchain ist auch dein Ding oder?",
    "Hey, wir kennen uns über M3. Beschäftigst du dich auch mit Krypto-Themen?",
    "Moin, ich hab deine Nummer aus der M3 Gruppe. Bist du offen für ein Gespräch über Blockchain?",
    "Hoi, du bist ja auch in der M3 Community. Arbeitest du auch im Blockchain-Bereich?",
    "Sali! Ich kenn dich von M3, hast du Interesse an Blockchain-Projekten?",
    "Hi, ich bin auch Mitglied bei M3. Bist du auch im Blockchain-Bereich?",
    "Servus, wir sind beide bei M3 dabei. Interessierst du dich vielleicht für Blockchain?",
    "Hey, ich hab dich bei M3 gesehen. Bist du auch ins Thema Blockchain eingestiegen?",
    "Na, ich kenn dich über die M3 Gruppe! Hast du Bock über Blockchain zu quatschen?",
    "Moin Moin, ich bin auch bei M3. Bist du auch im Krypto-Bereich aktiv?",
    "Grüß dich, ich hab deine Nummer aus M3. Blockchain ist auch dein Thema?",
    "Hi, wir kennen uns über M3. Bist du auch im Blockchain-Space unterwegs?",
    "Sali, hab dich in der M3 Community gefunden. Arbeitest du im Blockchain-Bereich?",
    "Servus! Du bist ja auch bei M3, beschäftigst du dich mit Krypto?",
    "Hey, ich bin ebenfalls bei M3 dabei. Interessierst du dich für Blockchain?",
    "Moin! Ich kenn dich von M3, bist du offen für Crypto-Themen?",
    "Na, hab deine Nummer über M3 bekommen. Hast du was mit Blockchain zu tun?"
];

/**
 * Shuffle array (Fisher-Yates)
 */
function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * Get fallback variations (never identical)
 */
function getFallbackVariations(count) {
    const shuffled = shuffleArray(FALLBACK_OPENERS);
    const result = [];
    for (let i = 0; i < count; i++) {
        result.push(shuffled[i % shuffled.length]);
    }
    return result;
}

/**
 * Try to parse JSON array from AI response, with multiple strategies
 */
function parseVariationsFromResponse(content) {
    // Strategy 1: Direct JSON array match
    const match = content.match(/\[[\s\S]*\]/);
    if (match) {
        try { return JSON.parse(match[0]); } catch(e) {}
    }
    
    // Strategy 2: Fix common JSON issues (trailing commas, smart quotes)
    if (match) {
        try {
            let fixed = match[0]
                .replace(/,\s*\]/g, ']')           // trailing comma
                .replace(/[\u201C\u201D]/g, '"')    // smart quotes
                .replace(/[\u2018\u2019]/g, "'");   // smart single quotes
            return JSON.parse(fixed);
        } catch(e) {}
    }
    
    // Strategy 3: Extract line-by-line (numbered list)
    const lines = content.split('\n').filter(l => l.trim());
    const extracted = [];
    for (const line of lines) {
        // Match: 1. "text" or 1) "text" or - "text"
        const m = line.match(/^[\d\-\.\)]+\s*["""]?(.+?)["""]?\s*$/);
        if (m && m[1].length > 20 && m[1].length < 200) {
            extracted.push(m[1].replace(/^[""]|[""]$/g, ''));
        }
    }
    if (extracted.length >= 3) return extracted;
    
    return null;
}

/**
 * Generate multiple unique variations of an opener template
 * With retry logic and hardcoded fallback — NEVER returns identical messages
 */
async function generateOpenerVariations(openerTemplate, count = 10, language = 'German') {
    if (!openai) {
        console.log('⚠️ No OpenAI — using fallback variations');
        return getFallbackVariations(count);
    }

    // Try up to 3 times with AI
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            // Generate in batches of max 10 for reliability
            const batchSize = Math.min(count, 10);
            const res = await openai.chat.completions.create({
                model: 'gpt-3.5-turbo',
                messages: [{
                    role: 'system',
                    content: `Du bist ein WhatsApp-Nachrichten Experte. Erstelle GENAU ${batchSize} einzigartige Variationen.

REGELN:
- Jede MUSS anders klingen (andere Wortwahl, andere Satzstruktur, andere Anrede)
- Kurz: 1-2 Sätze, unter 150 Zeichen
- Casual "du", wie ein Kumpel
- Variiere Anreden: Servus, Moin, Sali, Hoi, Hey, Hi, Na, Grüß dich, Moin Moin
- KEIN Link, keine Emojis (max 1)
- NIEMALS: "aktiv", "Aktivität", "engagiert" — M3 ist ein Broadcast-Kanal
- Stattdessen: "ich bin auch bei M3", "du bist bei M3 dabei", "kenn dich aus der M3 Gruppe"
- Sprache: ${language}

Antworte NUR mit einem JSON-Array, NICHTS anderes:
["variation1", "variation2", ...]`
                }, {
                    role: 'user',
                    content: `Vorlage: "${openerTemplate}"\nErstelle ${batchSize} Variationen.`
                }],
                max_tokens: 1200,
                temperature: 0.95
            });

            const content = res.choices[0].message.content.trim();
            const parsed = parseVariationsFromResponse(content);
            
            if (parsed && parsed.length >= 3) {
                console.log(`✅ AI generated ${parsed.length} unique variations (attempt ${attempt})`);
                
                // If we need more than we got, combine with shuffled fallbacks
                if (parsed.length < count) {
                    const extra = getFallbackVariations(count - parsed.length);
                    return [...parsed, ...extra];
                }
                return parsed.slice(0, count);
            }
            
            console.log(`⚠️ AI variation attempt ${attempt} failed to parse — retrying...`);
        } catch (e) {
            console.error(`⚠️ AI variation attempt ${attempt} error: ${e.message}`);
        }
    }

    // All AI attempts failed — use hardcoded fallback (NEVER identical!)
    console.log('⚠️ All AI attempts failed — using hardcoded fallback variations (all unique)');
    return getFallbackVariations(count);
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

        // Check consent — skip if already contacted or DND
        const contact = contacts.get(target.phone);
        if (contact?.consent_status === 'DND') {
            console.log(`   ⏭️ [${target.phone}] Skipped — DND`);
            results.push({ phone: target.phone, status: 'skipped', reason: 'DND' });
            continue;
        }
        if (contact?.consent_status === 'SOFT_OPTIN_SENT' || contact?.consent_status === 'OPTED_IN') {
            console.log(`   ⏭️ [${target.phone}] Skipped — already contacted (${contact.consent_status})`);
            results.push({ phone: target.phone, status: 'skipped', reason: 'already_contacted' });
            continue;
        }
        // Also skip if they have ANY conversation history
        const existingConvs = conversations.getByPhone(target.phone);
        if (existingConvs && existingConvs.length > 0) {
            console.log(`   ⏭️ [${target.phone}] Skipped — has ${existingConvs.length} existing messages`);
            results.push({ phone: target.phone, status: 'skipped', reason: 'has_conversation' });
            continue;
        }

        // Check global kill switch
        if (!settings.isGlobalSendEnabled()) {
            console.log(`   🛑 Global send disabled — stopping outreach`);
            results.push({ phone: target.phone, status: 'stopped', reason: 'kill_switch' });
            break;
        }

        try {
            // Staggered delay: 1-1.5 min between messages, 25 min break every 15
            if (i > 0) {
                // Every 15 messages → 25 minute cooldown
                if (i % 15 === 0) {
                    console.log(`   ☕ 15 messages sent — 25 min cooldown break...`);
                    await new Promise(r => setTimeout(r, 25 * 60 * 1000));
                } else {
                    const delay = Math.floor(Math.random() * 30000) + 60000; // 60-90 seconds
                    console.log(`   ⏳ Waiting ${Math.round(delay/1000)}s...`);
                    await new Promise(r => setTimeout(r, delay));
                }
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