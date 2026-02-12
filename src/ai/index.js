/**
 * AI Module
 * Handles AI-powered responses using OpenAI
 * Integrates with knowledge base for context-aware replies
 */

require('dotenv').config();
const OpenAI = require('openai');
const { knowledge, conversations } = require('../database/db');
const { splitMessage, MAX_MESSAGE_LENGTH } = require('../humanizer');

// Initialize OpenAI client
let openai = null;

function initializeAI() {
    if (process.env.OPENAI_API_KEY) {
        openai = new OpenAI({
            apiKey: process.env.OPENAI_API_KEY
        });
        console.log('✅ OpenAI initialized');
    } else {
        console.log('⚠️ No OpenAI API key found. AI features disabled.');
    }
}

/**
 * Get relevant knowledge base entries for context
 */
function getRelevantKnowledge(query) {
    const results = knowledge.search(query);
    return results.map(r => ({
        category: r.category,
        question: r.question,
        answer: r.answer
    }));
}

/**
 * Build context from conversation history
 */
function buildConversationContext(phone, maxMessages = 10) {
    const history = conversations.getRecent(phone, maxMessages);
    return history.map(msg => ({
        role: msg.direction === 'incoming' ? 'user' : 'assistant',
        content: msg.message
    }));
}

/**
 * Build system prompt with knowledge base
 */
function buildSystemPrompt(context = {}) {
    const { contactName, companyName, stage, ccb, detectedLanguage } = context;
    
    // Default to German, but adapt if client writes in another language
    const lang = detectedLanguage || 'German';
    
    let systemPrompt = `Du bist eine echte Person die auf WhatsApp schreibt. Du darfst NIEMALS sagen dass du ein Bot, Assistent oder KI bist. Du bist ein Mensch der für ein Blockchain-Projekt arbeitet. Du führst lockere, menschliche Gespräche um Termine zu buchen.

IDENTITÄT:
- Du bist ein MENSCH, kein Bot oder Assistent
- Wenn jemand fragt wer du bist: "Ich arbeite im Bereich Blockchain und Vermögensschutz"
- NIEMALS sagen: "Ich bin ein Assistent/Bot/KI/Vertriebsassistent"
- Verhalte dich wie ein normaler Mensch der auf WhatsApp schreibt

DEIN ZIEL: Führe den Kontakt zu einem Buchungstermin: https://calendly.com/vermoegensschutz_beratung

KOMMUNIKATIONSREGELN:
1. Antworte KURZ — maximal 1-2 Sätze pro Nachricht
2. Sei locker und freundlich, wie ein Freund der eine Empfehlung gibt
3. Nicht zu viele Emojis (maximal 1 pro Nachricht)
4. STANDARDSPRACHE: Deutsch (${lang})
5. SPRACHANPASSUNG: Wenn der Kontakt in einer anderen Sprache schreibt, wechsle in DEREN Sprache
6. Duze den Kontakt

VERKAUFSREGELN:
- Wir bauen eine L1 & L2 Blockchain mit Möglichkeiten für passives Einkommen
- NIEMALS spezifische Details geben (keine Zahlen, keine Renditen, keine Tokenomics)
- NIEMALS Whitepaper oder technische Dokumente teilen
- NIEMALS Preisinformationen geben
- Wenn nach Details gefragt wird: "Das erkläre ich am besten persönlich in einem kurzen Gespräch"
- Nach maximal 2-3 Nachrichten den Calendly-Link senden
- IMMER zum Termin führen, nie zu viel verraten

TERMINBUCHUNG:
- Calendly-Link: https://calendly.com/vermoegensschutz_beratung
- Sende den Link wenn Interesse da ist mit: "Hier kannst du dir direkt einen Termin buchen: https://calendly.com/vermoegensschutz_beratung"
- Mache es einfach und unkompliziert`;

    if (contactName) {
        systemPrompt += `\n\nDu sprichst mit ${contactName}.`;
    }

    if (companyName) {
        systemPrompt += `\nDu repräsentierst ${companyName}.`;
    }

    if (stage) {
        const stageInstructions = {
            'INTRO': 'Opener wurde gesendet. Warte auf Antwort. Wenn sie antworten, sei freundlich und frage ob sie offen für neue Möglichkeiten sind.',
            'QUALIFYING': 'Der Kontakt hat geantwortet. Kurz erklären: "Wir bauen eine L1 & L2 Blockchain mit passivem Einkommen." Dann direkt zum Termin leiten. NICHT zu viel erklären.',
            'VALUE_DELIVERY': 'Interesse ist da! Jetzt den Calendly-Link senden: https://calendly.com/vermoegensschutz_beratung — Sage: "Am besten erkläre ich dir das persönlich. Buch dir hier einen Termin:"',
            'BOOKING': 'Calendly-Link wurde gesendet. Frage ob er sich einen Termin gebucht hat. Wenn nicht, sanft nachfragen.',
            'FOLLOW_UP': 'Kurze Nachfrage: "Hey, hast du dir schon einen Termin ansehen können?" Nicht aufdringlich sein.',
            'WON': 'Termin wurde gebucht! Bestätige kurz und sei freundlich. "Top, freue mich auf das Gespräch!"',
            'LOST': 'Kein Interesse. Respektiere die Entscheidung. "Kein Problem, alles Gute dir!"'
        };
        systemPrompt += `\n\nAktuelle Phase: ${stage}\nAnweisung: ${stageInstructions[stage] || ''}`;
    }

    if (ccb) {
        systemPrompt += `\n\nKontext über diesen Kontakt: ${ccb}`;
    }

    return systemPrompt;
}

/**
 * Generate AI response based on context and knowledge base
 */
async function generateResponse(phone, incomingMessage, options = {}) {
    if (!openai) {
        return null; // AI not available
    }

    const { contactName, companyName, stage, ccb, maxTokens = 150 } = options;

    try {
        // Get relevant knowledge
        const relevantKnowledge = getRelevantKnowledge(incomingMessage);
        
        // Build conversation history
        const conversationHistory = buildConversationContext(phone);
        
        // Build system prompt with stage + CCB context
        let systemPrompt = buildSystemPrompt({ contactName, companyName, stage, ccb });
        
        // Add knowledge base context if relevant
        if (relevantKnowledge.length > 0) {
            systemPrompt += '\n\nRelevant information:\n';
            relevantKnowledge.forEach(k => {
                systemPrompt += `- ${k.answer}\n`;
            });
        }

        // Build messages array
        const messages = [
            { role: 'system', content: systemPrompt },
            ...conversationHistory,
            { role: 'user', content: incomingMessage }
        ];

        const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: messages,
            max_tokens: maxTokens,
            temperature: 0.7,
            presence_penalty: 0.6,
            frequency_penalty: 0.5
        });

        const response = completion.choices[0].message.content.trim();
        
        // Split into human-like messages
        return splitMessage(response);
    } catch (error) {
        console.error('AI Error:', error.message);
        return null;
    }
}

/**
 * Generate a personalized first message for outreach
 */
async function generateFirstMessage(contact, purpose = 'outreach') {
    if (!openai) {
        return null;
    }

    const { name, company, notes } = contact;

    const systemPrompt = `You are writing a first message for professional outreach on WhatsApp.
Keep it SHORT (max 70 chars), friendly, and personalized.
Don't be salesy or pushy. Be genuine.`;

    const userPrompt = `Write a short first message to ${name || 'a potential contact'}${company ? ` from ${company}` : ''}.
${notes ? `Context: ${notes}` : ''}
Purpose: ${purpose}`;

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            max_tokens: 100,
            temperature: 0.8
        });

        const response = completion.choices[0].message.content.trim();
        return splitMessage(response);
    } catch (error) {
        console.error('AI Error:', error.message);
        return null;
    }
}

/**
 * Analyze incoming message for intent
 */
async function analyzeIntent(message) {
    if (!openai) {
        return { intent: 'unknown', confidence: 0 };
    }

    try {
        const completion = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [
                {
                    role: 'system',
                    content: `Classify the intent of this message. Respond with only one of:
- greeting
- question
- interest
- not_interested
- objection
- confirmation
- thanks
- other`
                },
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

/**
 * Check if AI is available
 */
function isAvailable() {
    return openai !== null;
}

module.exports = {
    initializeAI,
    generateResponse,
    generateFirstMessage,
    analyzeIntent,
    isAvailable,
    getRelevantKnowledge
};