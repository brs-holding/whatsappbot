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
    const { contactName, companyName } = context;
    
    let systemPrompt = `You are a helpful, friendly WhatsApp assistant. You respond like a human would in casual text messages.

IMPORTANT RULES:
1. Keep responses SHORT - maximum 70 characters per message
2. Be conversational and casual
3. Don't use emojis excessively
4. Don't be overly formal
5. Respond naturally as if texting a friend`;

    if (contactName) {
        systemPrompt += `\n\nYou are talking to ${contactName}.`;
    }

    if (companyName) {
        systemPrompt += `\nYou represent ${companyName}.`;
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

    const { contactName, companyName, maxTokens = 150 } = options;

    try {
        // Get relevant knowledge
        const relevantKnowledge = getRelevantKnowledge(incomingMessage);
        
        // Build conversation history
        const conversationHistory = buildConversationContext(phone);
        
        // Build system prompt
        let systemPrompt = buildSystemPrompt({ contactName, companyName });
        
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