/**
 * Pipeline State Machine + CCB Generator
 * Manages: INTRO → QUALIFYING → VALUE_DELIVERY → BOOKING → FOLLOW_UP → WON/LOST/DND
 */

require('dotenv').config();
const OpenAI = require('openai');
const { contacts, conversations, events, knowledge, uuid } = require('../database/db');

const STAGES = ['INTRO', 'QUALIFYING', 'VALUE_DELIVERY', 'BOOKING', 'FOLLOW_UP', 'WON', 'LOST', 'DND'];

let openai = null;
function initPipeline() {
    if (process.env.OPENAI_API_KEY) {
        openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
}

// ═══════════════ INTENT CLASSIFIER ═══════════════
async function classifyIntent(message) {
    if (!openai) return { intent: 'other', sentiment: 'neutral', urgency: 'low', confidence: 0 };
    
    try {
        const res = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{
                role: 'system',
                content: `Classify this message. Return ONLY valid JSON:
{"intent":"one of: greeting|question|interest|not_interested|objection|confirmation|thanks|appointment|pricing|other",
"sentiment":"positive|neutral|negative|hostile",
"urgency":"high|medium|low",
"slots":{"budget":null,"timeline":null,"location":null}}`
            }, { role: 'user', content: message }],
            max_tokens: 120, temperature: 0
        });
        return JSON.parse(res.choices[0].message.content.trim());
    } catch (e) {
        return { intent: 'other', sentiment: 'neutral', urgency: 'low', confidence: 0 };
    }
}

// ═══════════════ STAGE TRANSITIONS ═══════════════
const transitions = {
    INTRO: (intent) => {
        if (['interest', 'question', 'pricing', 'greeting'].includes(intent)) return 'QUALIFYING';
        if (intent === 'not_interested') return 'LOST';
        if (intent === 'confirmation') return 'QUALIFYING';
        return 'INTRO';
    },
    QUALIFYING: (intent) => {
        if (intent === 'appointment') return 'BOOKING';
        if (intent === 'not_interested') return 'LOST';
        // Any positive signal → fast-track to VALUE_DELIVERY (Calendly link)
        if (['interest', 'confirmation', 'question', 'thanks'].includes(intent)) return 'VALUE_DELIVERY';
        return 'QUALIFYING';
    },
    VALUE_DELIVERY: (intent) => {
        if (['appointment', 'confirmation', 'interest', 'thanks'].includes(intent)) return 'BOOKING';
        if (intent === 'not_interested') return 'LOST';
        return 'VALUE_DELIVERY';
    },
    BOOKING: (intent) => {
        if (intent === 'confirmation') return 'WON';
        if (intent === 'not_interested') return 'LOST';
        return 'BOOKING';
    },
    FOLLOW_UP: (intent) => {
        if (['interest', 'question', 'confirmation'].includes(intent)) return 'QUALIFYING';
        if (intent === 'not_interested') return 'LOST';
        return 'FOLLOW_UP';
    },
    WON: () => 'WON',
    LOST: (intent) => intent === 'interest' ? 'QUALIFYING' : 'LOST',
    DND: () => 'DND'
};

function getNextStage(currentStage, intent) {
    const fn = transitions[currentStage];
    return fn ? fn(intent) : currentStage;
}

// ═══════════════ CCB GENERATOR (Two-Pass) ═══════════════

/**
 * Pass A: Extract structured facts from conversation
 */
async function extractFacts(phone) {
    if (!openai) return null;
    
    const recent = conversations.getRecent(phone, 15);
    if (recent.length === 0) return null;

    const chatHistory = recent.map(m => 
        `${m.direction === 'incoming' ? 'CONTACT' : 'BOT'}: ${m.message}`
    ).join('\n');

    const contact = contacts.get(phone);

    try {
        const res = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{
                role: 'system',
                content: `Extract ONLY factual data from this conversation. Return valid JSON:
{
  "profile": { "name": null, "company": null, "role": null, "location": null, "language": null },
  "interest": { "primary_product": null, "secondary_interest": null, "use_case": null },
  "budget": { "mentioned": false, "range": null, "currency": null },
  "timeline": { "mentioned": false, "urgency": null, "specific_date": null },
  "objections": [],
  "questions_asked": [],
  "sentiment": "positive|neutral|negative",
  "engagement_level": "high|medium|low|none",
  "key_facts": []
}
Be strictly factual. Only extract what was explicitly said.`
            }, {
                role: 'user',
                content: `Contact info: ${contact?.name || 'Unknown'}, ${contact?.company || 'Unknown'}\n\nConversation:\n${chatHistory}`
            }],
            max_tokens: 500, temperature: 0
        });
        return JSON.parse(res.choices[0].message.content.trim());
    } catch (e) {
        console.error('CCB Extract error:', e.message);
        return null;
    }
}

/**
 * Pass B: Strategic analysis → stage + next actions + risk
 */
async function generateStrategy(phone, facts) {
    if (!openai || !facts) return null;
    
    const contact = contacts.get(phone);
    const currentStage = contact?.pipeline_stage || 'INTRO';

    try {
        const res = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo',
            messages: [{
                role: 'system',
                content: `You are a sales strategist. Given extracted facts about a contact, generate a Conversation Conclusion Bundle. Return valid JSON:
{
  "stage": {
    "current": "${currentStage}",
    "recommended": "INTRO|QUALIFYING|VALUE_DELIVERY|BOOKING|FOLLOW_UP|WON|LOST",
    "reason": "why this stage",
    "next_condition": "what moves them forward"
  },
  "conclusion": "2-3 sentence human-readable summary of who they are, what they want, what blocks the deal",
  "next_best_actions": [
    { "priority": 1, "action": "description", "needs_human": false }
  ],
  "follow_up": {
    "if_no_reply_hours": 10,
    "message_type": "micro_value_nudge|question|proof_asset",
    "max_followups": 1
  },
  "risk_score": 0,
  "risk_factors": [],
  "do_not": ["things to avoid with this contact"]
}`
            }, {
                role: 'user',
                content: `Current stage: ${currentStage}\nFacts: ${JSON.stringify(facts)}`
            }],
            max_tokens: 600, temperature: 0.3
        });
        return JSON.parse(res.choices[0].message.content.trim());
    } catch (e) {
        console.error('CCB Strategy error:', e.message);
        return null;
    }
}

/**
 * Full CCB generation pipeline
 */
async function generateCCB(phone) {
    const runId = uuid();
    
    // Pass A: Extract facts
    const facts = await extractFacts(phone);
    if (!facts) return null;

    // Pass B: Generate strategy
    const strategy = await generateStrategy(phone, facts);
    if (!strategy) return null;

    // Build CCB
    const ccb = {
        version: 1,
        generated_at: new Date().toISOString(),
        run_id: runId,
        facts,
        strategy,
        conclusion: strategy.conclusion,
        stage: strategy.stage,
        next_best_actions: strategy.next_best_actions,
        follow_up: strategy.follow_up,
        risk_score: strategy.risk_score,
        do_not: strategy.do_not
    };

    // Store CCB
    contacts.setCCB(phone, ccb);
    
    // Update stage if recommended
    if (strategy.stage?.recommended && strategy.stage.recommended !== strategy.stage.current) {
        contacts.setStage(phone, strategy.stage.recommended, strategy.stage.reason);
    }

    // Update risk score
    if (strategy.risk_score) {
        contacts.update(phone, { risk_score: strategy.risk_score });
    }

    events.add(phone, 'CCB_GENERATED', { run_id: runId, stage: strategy.stage?.recommended });

    return ccb;
}

// ═══════════════ PROCESS MESSAGE (main entry point) ═══════════════

/**
 * Process an incoming message through the full pipeline
 * Returns: { intent, stage, ccb, actions }
 */
async function processMessage(phone, message) {
    const runId = uuid();
    
    // 1. Classify intent
    const intentResult = await classifyIntent(message);
    events.add(phone, 'INTENT_CLASSIFIED', { ...intentResult, run_id: runId });

    // 2. Determine stage transition
    const contact = contacts.get(phone);
    const currentStage = contact?.pipeline_stage || 'INTRO';
    const nextStage = getNextStage(currentStage, intentResult.intent);
    
    if (nextStage !== currentStage) {
        contacts.setStage(phone, nextStage, `Intent: ${intentResult.intent}`);
    }

    // 3. Generate/update CCB (every 3rd message or on stage change)
    const msgCount = conversations.getByPhone(phone).length;
    let ccb = contacts.getCCB(phone);
    
    if (!ccb || nextStage !== currentStage || msgCount % 3 === 0) {
        ccb = await generateCCB(phone);
    }

    return {
        intent: intentResult,
        previousStage: currentStage,
        currentStage: nextStage,
        ccb,
        runId
    };
}

module.exports = {
    initPipeline,
    classifyIntent,
    getNextStage,
    generateCCB,
    extractFacts,
    generateStrategy,
    processMessage,
    STAGES
};