/**
 * Safety Core — Kill Switch, Validator Gate, Escalation Engine
 * 4-layer circuit breaker + content validation + high-stakes escalation
 */

const { settings, contacts, events } = require('../database/db');

// ═══════════════ FORBIDDEN CONTENT ═══════════════
const FORBIDDEN_CLAIMS = [
    'guaranteed return', 'guaranteed roi', 'guaranteed profit',
    'risk-free', 'risk free', 'no risk', 'zero risk',
    'guaranteed apy', 'guaranteed yield',
    'we promise', 'i promise', 'i guarantee',
    'legal advice', 'legal protection',
    'investment advice', 'financial advice',
    'you will make', 'you\'ll make',
    'double your money', 'triple your money'
];

const FORBIDDEN_PATTERNS = [
    /guaranteed?\s*(return|roi|profit|yield|apy)/i,
    /risk[\s-]?free/i,
    /no\s+risk/i,
    /we\s+(promise|guarantee)/i,
    /i\s+(promise|guarantee)/i,
    /(legal|financial|investment)\s+advice/i,
    /you\s+(will|can)\s+make\s+\$?\d+/i,
    /double\s+your\s+(money|investment)/i
];

// ═══════════════ ESCALATION TRIGGERS ═══════════════
const ESCALATION_KEYWORDS = [
    'contract', 'contracts', 'legal agreement',
    'guarantee', 'guarantees',
    'scam', 'fraud', 'fake', 'ponzi',
    'lawyer', 'attorney', 'sue',
    'wallet address', 'send money', 'wire transfer',
    'payment', 'bank transfer'
];

const DND_KEYWORDS = [
    'stop', 'unsubscribe', 'remove me', 'don\'t contact',
    'leave me alone', 'block', 'no more messages',
    'opt out', 'opt-out', 'delete my number',
    'hör auf', 'lass mich in ruhe', 'nicht mehr schreiben',
    'bitte aufhören', 'keine nachrichten mehr', 'lösch meine nummer',
    'schreib mir nicht mehr', 'will keine nachrichten'
];

// ═══════════════ KILL SWITCH (4-layer) ═══════════════
const killSwitch = {
    /**
     * Layer 1: Global send toggle
     */
    isGlobalEnabled: () => settings.isGlobalSendEnabled(),

    /**
     * Layer 2: Per-contact pause
     */
    isContactEnabled: (phone) => contacts.isSendAllowed(phone),

    /**
     * Layer 3: Error-rate circuit breaker
     * Track consecutive errors, pause if too many
     */
    errorCount: 0,
    maxConsecutiveErrors: 3,
    
    recordError: () => {
        killSwitch.errorCount++;
        if (killSwitch.errorCount >= killSwitch.maxConsecutiveErrors) {
            console.log('⚠️ CIRCUIT BREAKER: Too many errors, pausing global send');
            settings.set('global_send_enabled', 'false');
            events.add('SYSTEM', 'CIRCUIT_BREAKER_TRIPPED', { 
                reason: 'consecutive_errors', 
                count: killSwitch.errorCount 
            });
        }
    },
    
    recordSuccess: () => { killSwitch.errorCount = 0; },

    /**
     * Layer 4: Content-policy breaker (handled by validator)
     */

    /**
     * Master check: Can we send to this contact?
     */
    canSend: (phone) => {
        if (!killSwitch.isGlobalEnabled()) return { allowed: false, reason: 'global_send_disabled' };
        if (!killSwitch.isContactEnabled(phone)) return { allowed: false, reason: 'contact_blocked' };
        return { allowed: true };
    },

    /**
     * Emergency: disable all sending
     */
    emergencyStop: () => {
        settings.set('global_send_enabled', 'false');
        events.add('SYSTEM', 'EMERGENCY_STOP', { timestamp: new Date().toISOString() });
        console.log('🚨 EMERGENCY STOP: All sending disabled');
    },

    /**
     * Resume sending
     */
    resume: () => {
        settings.set('global_send_enabled', 'true');
        killSwitch.errorCount = 0;
        console.log('✅ Global sending resumed');
    }
};

// ═══════════════ VALIDATOR GATE ═══════════════
const validator = {
    /**
     * Validate a message before sending
     * Returns { valid: bool, violations: [], sanitized: string }
     */
    validate: (message, context = {}) => {
        const violations = [];
        const maxChars = parseInt(settings.get('max_chars_per_message') || '420');

        // 1. Length check
        if (message.length > maxChars) {
            violations.push({ rule: 'length', detail: `Message exceeds ${maxChars} chars (${message.length})` });
        }

        // 2. Forbidden claims check
        const lowerMsg = message.toLowerCase();
        for (const claim of FORBIDDEN_CLAIMS) {
            if (lowerMsg.includes(claim)) {
                violations.push({ rule: 'forbidden_claim', detail: `Contains: "${claim}"` });
            }
        }

        // 3. Forbidden patterns check
        for (const pattern of FORBIDDEN_PATTERNS) {
            if (pattern.test(message)) {
                violations.push({ rule: 'forbidden_pattern', detail: `Matches pattern: ${pattern}` });
            }
        }

        // 4. Link check (based on policy)
        const linkPolicy = settings.get('link_policy') || 'no_links_until_engagement';
        const hasLinks = /https?:\/\/|www\.|\.com|\.io|\.org/i.test(message);
        if (hasLinks && linkPolicy === 'no_links_until_engagement') {
            const contact = context.phone ? contacts.get(context.phone) : null;
            const stage = contact?.pipeline_stage || 'INTRO';
            if (['INTRO', 'QUALIFYING'].includes(stage)) {
                violations.push({ rule: 'link_policy', detail: 'Links not allowed before engagement' });
            }
        }

        // 5. Bot identity check
        if (/i('m| am) (a |an? )?(bot|ai|artificial|machine|program)/i.test(message)) {
            violations.push({ rule: 'identity', detail: 'Must not reveal bot identity' });
        }

        // 6. CTA check (should have a question or call to action)
        // Soft check - just a warning, not blocking
        const hasCTA = /\?|let me know|what do you think|would you|are you|can you|shall we/i.test(message);

        return {
            valid: violations.length === 0,
            violations,
            hasCTA,
            charCount: message.length,
            message: message
        };
    }
};

// ═══════════════ CONSENT ENGINE ═══════════════
const consent = {
    /**
     * Check if incoming message contains DND signals
     */
    checkDND: (message) => {
        const lower = message.toLowerCase().trim();
        return DND_KEYWORDS.some(kw => lower.includes(kw));
    },

    /**
     * Process consent for a contact
     * Returns: action to take
     */
    processInbound: (phone, message) => {
        const contact = contacts.get(phone);
        if (!contact) return { action: 'none' };

        // Check for DND signals
        if (consent.checkDND(message)) {
            contacts.setDND(phone);
            return { action: 'dnd_set', reply: "Alles klar, werde mich nicht mehr melden. Alles Gute!" };
        }

        // If they replied, they're at least soft opted in
        if (contact.consent_status === 'UNKNOWN' || contact.consent_status === 'SOFT_OPTIN_SENT') {
            contacts.setConsent(phone, 'OPTED_IN');
            return { action: 'opted_in' };
        }

        return { action: 'none' };
    },

    /**
     * Check if we can send the first message to this contact
     */
    canInitiateContact: (phone) => {
        const contact = contacts.get(phone);
        if (!contact) return { allowed: true, type: 'new_contact' };

        switch (contact.consent_status) {
            case 'UNKNOWN':
                return { allowed: true, type: 'permission_check_only' };
            case 'SOFT_OPTIN_SENT':
                return { allowed: false, reason: 'Waiting for reply to permission check' };
            case 'OPTED_IN':
                return { allowed: true, type: 'full_messaging' };
            case 'DND':
                return { allowed: false, reason: 'Contact is DND' };
            default:
                return { allowed: true, type: 'unknown_state' };
        }
    }
};

// ═══════════════ ESCALATION ENGINE ═══════════════
const escalation = {
    /**
     * Check if a message triggers escalation
     */
    check: (message, context = {}) => {
        const lower = message.toLowerCase();
        const triggers = [];

        // Keyword triggers
        for (const kw of ESCALATION_KEYWORDS) {
            if (lower.includes(kw)) {
                triggers.push({ type: 'keyword', keyword: kw });
            }
        }

        // Repeated "scam" mentions
        if ((lower.match(/scam/g) || []).length >= 2) {
            triggers.push({ type: 'repeated_scam_mention' });
        }

        // High investment amount
        const amountMatch = message.match(/\$[\d,]+/g);
        if (amountMatch) {
            const amounts = amountMatch.map(a => parseInt(a.replace(/[$,]/g, '')));
            if (amounts.some(a => a > 10000)) {
                triggers.push({ type: 'high_investment', amount: Math.max(...amounts) });
            }
        }

        // Anger/threat detection
        if (/fuck|shit|threat|kill|hurt|report|police|authorities/i.test(lower)) {
            triggers.push({ type: 'anger_or_threat' });
        }

        if (triggers.length > 0) {
            return {
                escalate: true,
                triggers,
                action: 'HUMAN_REQUIRED',
                holdingReply: "Gute Frage, da verbinde ich dich am besten mit einem Kollegen der dir das genauer erklären kann.",
                riskIncrease: triggers.length * 15
            };
        }

        return { escalate: false, triggers: [] };
    },

    /**
     * Execute escalation for a contact
     */
    execute: (phone, triggers) => {
        contacts.setHumanRequired(phone, true);
        contacts.update(phone, { 
            risk_score: Math.min(100, (contacts.get(phone)?.risk_score || 0) + triggers.length * 15)
        });
        events.add(phone, 'ESCALATION_TRIGGERED', { triggers });
        console.log(`🚨 ESCALATION: ${phone} requires human attention. Triggers: ${JSON.stringify(triggers)}`);
    }
};

module.exports = { killSwitch, validator, consent, escalation };