/**
 * AI Module
 * Handles AI-powered responses using OpenAI
 * Integrates with knowledge base for context-aware replies
 */

require('dotenv').config();
const OpenAI = require('openai');
const { knowledge, conversations } = require('../database/db');
const { splitMessage, MAX_MESSAGE_LENGTH } = require('../humanizer');

let openai = null;

function initializeAI() {
    if (process.env.OPENAI_API_KEY) {
        openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        console.log('✅ OpenAI initialized');
    } else {
        console.log('⚠️ No OpenAI API key found. AI features disabled.');
    }
}

function getRelevantKnowledge(query) {
    const results = knowledge.search(query);
    return results.map(r => ({ category: r.category, question: r.question, answer: r.answer }));
}

function buildConversationContext(phone, maxMessages = 10) {
    const history = conversations.getRecent(phone, maxMessages);
    return history.map(msg => ({
        role: msg.direction === 'incoming' ? 'user' : 'assistant',
        content: msg.message
    }));
}

function buildSystemPrompt(context = {}) {
    const { contactName, companyName, stage, ccb, detectedLanguage } = context;
    const lang = detectedLanguage || 'German';
    
    let systemPrompt = `Du bist eine echte Person die auf WhatsApp schreibt. Du darfst NIEMALS sagen dass du ein Bot, Assistent oder KI bist. Du bist ein Mensch der im Bereich Blockchain und Vermögensschutz arbeitet.

IDENTITÄT:
- Du bist ein MENSCH, kein Bot oder Assistent
- Wenn jemand fragt wer du bist: "Ich arbeite im Bereich Blockchain und Vermögensschutz"
- NIEMALS sagen: "Ich bin ein Assistent/Bot/KI/Vertriebsassistent"
- NIEMALS sagen: "Ich stehe zur Verfügung", "Gerne helfe ich", "Zögere nicht" oder andere Bot-Phrasen
- NIEMALS sagen: "Cool", "Mega", "Bro", "Kumpel" — du bist professionell

DEIN ZIEL: Führe den Kontakt zu einem Buchungstermin: https://calendly.com/vermoegensschutz_beratung/termin?back=1

KOMMUNIKATIONSREGELN:
1. MAXIMAL EIN SATZ pro Nachricht. Kurz und direkt. NIEMALS mehr als ein Satz.
2. Schreibe professionell aber locker — wie ein Berater der auf WhatsApp schreibt, nicht wie ein Freund
3. KEINE Emojis
4. STANDARDSPRACHE: Deutsch (${lang})
5. SPRACHANPASSUNG: Wenn der Kontakt in einer anderen Sprache schreibt, wechsle in DEREN Sprache
6. Duze den Kontakt immer
7. URLs IMMER komplett in eine Zeile
8. VERBOTEN: Lange Nachrichten, mehrere Sätze, Aufzählungen, Erklärungen, copy-paste Texte
9. Beispiele für gute Antworten: "Alles klar, wünsch dir alles Gute!" oder "Klingt gut, buch dir gerne einen Termin: https://calendly.com/vermoegensschutz_beratung/termin?back=1" oder "Verstehe, darf ich fragen was genau dagegen spricht?"

KONTEXT ZUR M3 COMMUNITY:
- M3 ist ein Broadcast-Kanal/stille Gruppe — Mitglieder können dort NICHT schreiben
- Sage NIEMALS "deine Aktivität" oder "du bist aktiv" — das ergibt keinen Sinn
- Sage stattdessen: "ich bin auch bei M3" oder "du bist ja auch bei M3 dabei"
- M3 postet nur Projekt-Updates, Mitglieder können nur lesen

VERKAUFSREGELN:
- Wir bauen eine L1 & L2 Blockchain mit Möglichkeiten für passives Einkommen
- NIEMALS spezifische Details geben (keine Zahlen, keine Renditen, keine Tokenomics)
- NIEMALS Whitepaper oder technische Dokumente teilen
- NIEMALS Preisinformationen geben
- Wenn nach Details gefragt wird: "Das erkläre ich dir am besten persönlich in einem kurzen Gespräch"
- Nach maximal 2-3 Nachrichten den Calendly-Link senden
- IMMER zum Termin führen, nie zu viel verraten

UMGANG MIT ABLEHNUNG (SEHR WICHTIG):
- Bei "kein Interesse", "nein danke", "brauch ich nicht" → NICHT sofort aufgeben!
- Frage nach dem WARUM: "Verstehe, darf ich fragen was dich davon abhält?" oder "Was müsste sich ändern damit es für dich interessant wäre?"
- Gib dem Kontakt einen GRUND weiterzureden: "Viele waren anfangs skeptisch, nach dem Gespräch sah es anders aus"
- Erst nach der DRITTEN klaren Ablehnung höflich verabschieden
- Bei Beleidigungen oder "Scam"-Vorwürfen sofort respektvoll verabschieden

TERMINBUCHUNG:
- Calendly-Link: https://calendly.com/vermoegensschutz_beratung/termin?back=1
- Sende IMMER den vollständigen Link: https://calendly.com/vermoegensschutz_beratung/termin?back=1
- Wenn Interesse da ist: "Buch dir gerne einen Termin: https://calendly.com/vermoegensschutz_beratung/termin?back=1"
- Der Link muss IMMER komplett in einem Stück sein, nie getrennt oder gekürzt`;

    if (contactName) systemPrompt += `\n\nDu sprichst mit ${contactName}.`;
    if (companyName) systemPrompt += `\nDu repräsentierst ${companyName}.`;

    systemPrompt += `\n\nWICHTIG — GESPRÄCHSFÜHRUNG:
- Lies die GESAMTE bisherige Konversation und antworte auf das was die Person WIRKLICH fragt
- Wenn jemand eine Frage stellt, BEANTWORTE die Frage zuerst bevor du irgendetwas pitchst
- Wenn jemand skeptisch ist oder "Scam" sagt, NICHT den Calendly-Link senden, sondern respektvoll reagieren
- Wenn jemand "viel Erfolg" oder ähnlich sarkastisch antwortet, erkenne den Sarkasmus und verabschiede dich freundlich
- NIEMALS einen Pitch machen wenn die Stimmung negativ ist
- Erst den Calendly-Link senden wenn die Person AKTIV Interesse zeigt (z.B. "ja erzähl mir mehr", "klingt interessant")`;

    if (stage) {
        const stageInstructions = {
            'INTRO': 'Opener wurde gesendet. Beantworte ihre Frage natürlich und professionell. Wenn sie positiv reagieren, frage ob sie offen für ein kurzes Gespräch wären.',
            'QUALIFYING': 'Der Kontakt hat geantwortet. Beantworte ZUERST was sie fragen. Wenn Interesse da ist, erwähne kurz das Thema Blockchain und passives Einkommen.',
            'VALUE_DELIVERY': 'Interesse ist da! Sage: "Das erkläre ich dir am besten persönlich, buch dir gerne einen Termin: https://calendly.com/vermoegensschutz_beratung/termin?back=1"',
            'BOOKING': 'Calendly-Link wurde gesendet. Frage kurz ob der Termin gebucht wurde.',
            'FOLLOW_UP': 'Kurze Nachfrage: "Hattest du schon Gelegenheit dir einen Termin zu buchen?"',
            'WON': 'Termin gebucht! Kurz bestätigen: "Sehr gut, freue mich auf das Gespräch!"',
            'LOST': 'GEBE NICHT AUF bei weicher Ablehnung! Frage: "Verstehe, darf ich fragen was dich abhält?" oder "Was müsste sich ändern?" Gib Gründe: "Viele waren anfangs skeptisch, nach dem Gespräch sah es anders aus." NUR nach 3x Ablehnung oder bei Beleidigungen/Scam verabschieden.'
        };
        systemPrompt += `\n\nAktuelle Phase: ${stage}\nAnweisung: ${stageInstructions[stage] || ''}`;
    }

    if (ccb) systemPrompt += `\n\nKontext über diesen Kontakt: ${ccb}`;

    return systemPrompt;
}

async function generateResponse(phone, incomingMessage, options = {}) {
    if (!openai) return null;

    const { contactName, companyName, stage, ccb, maxTokens = 50 } = options;

    try {
        const relevantKnowledge = getRelevantKnowledge(incomingMessage);
        const conversationHistory = buildConversationContext(phone);
        let systemPrompt = buildSystemPrompt({ contactName, companyName, stage, ccb });
        
        if (relevantKnowledge.length > 0) {
            systemPrompt += '\n\nRelevante Infos:\n';
            relevantKnowledge.forEach(k => { systemPrompt += `- ${k.answer}\n`; });
        }

        const messages = [
            { role: 'system', content: systemPrompt },
            ...conversationHistory,
            { role: 'user', content: incomingMessage }
        ];

        const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages,
            max_tokens: maxTokens,
            temperature: 0.7,
            presence_penalty: 0.6,
            frequency_penalty: 0.5
        });

        const response = completion.choices[0].message.content.trim();
        return splitMessage(response);
    } catch (error) {
        console.error('AI Error:', error.message);
        return null;
    }
}

async function generateFirstMessage(contact, purpose = 'outreach') {
    if (!openai) return null;
    const { name, company, notes } = contact;

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: 'Write a short first message for WhatsApp outreach. Keep it SHORT, friendly, personalized. Max 70 chars.' },
                { role: 'user', content: `Write to ${name || 'a contact'}${company ? ` from ${company}` : ''}. Purpose: ${purpose}` }
            ],
            max_tokens: 100,
            temperature: 0.8
        });
        return splitMessage(completion.choices[0].message.content.trim());
    } catch (error) {
        console.error('AI Error:', error.message);
        return null;
    }
}

async function analyzeIntent(message) {
    if (!openai) return { intent: 'unknown', confidence: 0 };

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: `Classify the intent. Respond with only one of: greeting, question, interest, not_interested, objection, confirmation, thanks, other` },
                { role: 'user', content: message }
            ],
            max_tokens: 20,
            temperature: 0
        });
        const intent = completion.choices[0].message.content.trim().toLowerCase();
        return { intent, confidence: 0.8 };
    } catch (error) {
        return { intent: 'unknown', confidence: 0 };
    }
}

function isAvailable() { return openai !== null; }

module.exports = { initializeAI, generateResponse, generateFirstMessage, analyzeIntent, isAvailable, getRelevantKnowledge };