/**
 * Smart Follow-up Scheduler + Booking Flow
 * German templates, 8min nudge sequence, 4hr reminder
 */

const { contacts, conversations, events, settings, queue } = require('../database/db');

// ═══════════════ FOLLOW-UP SCHEDULER ═══════════════

const followup = {
    /**
     * Check all contacts for follow-up opportunities
     */
    checkAll: () => {
        const allContacts = contacts.getAll();
        const needsFollowUp = [];

        for (const contact of allContacts) {
            if (contact.consent_status === 'DND') continue;
            if (contact.bot_paused || contact.human_required) continue;
            if (['WON', 'LOST', 'DND'].includes(contact.pipeline_stage)) continue;

            const result = followup.check(contact);
            if (result.needsFollowUp) {
                needsFollowUp.push({ contact, ...result });
            }
        }
        return needsFollowUp;
    },

    /**
     * Check if a single contact needs follow-up
     * 
     * NUDGE SEQUENCE:
     * - 8 min no reply → nudge #1
     * - 16 min no reply → nudge #2
     * - 24 min no reply → nudge #3
     * - 4 hours no reply → reminder
     * - Counter resets when customer replies
     */
    check: (contact) => {
        const recent = conversations.getRecent(contact.phone, 10);
        if (recent.length === 0) return { needsFollowUp: false };

        const lastMsg = recent[recent.length - 1];
        const lastTime = new Date(lastMsg.created_at).getTime();
        const minutesAgo = (Date.now() - lastTime) / (1000 * 60);
        const hoursAgo = minutesAgo / 60;

        // Last message was from them — no follow-up needed (we should reply, not nudge)
        if (lastMsg.direction === 'incoming') {
            return { needsFollowUp: false, reason: 'waiting_for_our_reply' };
        }

        // Count consecutive unanswered outgoing messages (since last incoming)
        let unansweredCount = 0;
        for (let i = recent.length - 1; i >= 0; i--) {
            if (recent[i].direction === 'outgoing') unansweredCount++;
            else break;
        }

        // ── 8-MINUTE NUDGE SEQUENCE (max 3 nudges) ──
        if (unansweredCount <= 3 && minutesAgo >= 8 && hoursAgo < 4) {
            // Nudge based on how many we've already sent
            if (unansweredCount === 1) {
                return { needsFollowUp: true, type: 'nudge', nudgeNumber: 1, minutesAgo: Math.round(minutesAgo), messageType: 'nudge_1' };
            } else if (unansweredCount === 2 && minutesAgo >= 8) {
                return { needsFollowUp: true, type: 'nudge', nudgeNumber: 2, minutesAgo: Math.round(minutesAgo), messageType: 'nudge_2' };
            } else if (unansweredCount === 3 && minutesAgo >= 8) {
                return { needsFollowUp: true, type: 'nudge', nudgeNumber: 3, minutesAgo: Math.round(minutesAgo), messageType: 'nudge_3' };
            }
        }

        // ── 4-HOUR REMINDER (after 3 nudges failed) ──
        if (unansweredCount >= 4 && hoursAgo >= 4 && hoursAgo < 48) {
            // Only send one 4hr reminder
            if (unansweredCount === 4) {
                return { needsFollowUp: true, type: 'reminder_4h', hoursAgo: Math.round(hoursAgo), messageType: 'reminder_4h' };
            }
        }

        // ── MAX REACHED — stop following up ──
        if (unansweredCount >= 5) {
            return { needsFollowUp: false, reason: 'max_followups_reached' };
        }

        return { needsFollowUp: false };
    },

    /**
     * Generate follow-up message based on type — ALL GERMAN
     */
    generateMessage: (contact, type) => {
        const name = contact.name ? ' ' + contact.name.split(' ')[0] : '';

        const templates = {
            // Nudge #1 (8 min) — short, casual check
            nudge_1: [
                `?`,
                `Und${name}?`,
                `Was meinst du?`,
                `Hast du kurz Zeit?`
            ],
            // Nudge #2 (16 min) — slightly more context
            nudge_2: [
                `Wäre doch schade, wenn du die Möglichkeit verpasst.`,
                `Kurzes Gespräch reicht, dann weisst du ob es passt.`,
                `Ich erkläre dir gerne alles in einem kurzen Call.`
            ],
            // Nudge #3 (24 min) — last try before pause
            nudge_3: [
                `Meld dich gerne wenn es passt, bin erreichbar.`,
                `Kein Stress, schreib mir einfach wenn du Zeit hast.`,
                `Ich bin da wenn du Fragen hast.`
            ],
            // 4-hour reminder — re-engage after longer pause
            reminder_4h: [
                `Hey${name}, hattest du schon Gelegenheit drüber nachzudenken?`,
                `Wollte nochmal kurz nachhaken${name ? ', ' + name.trim() : ''}, passt ein kurzes Gespräch diese Woche?`,
                `Hey${name}, wollte mich nochmal melden, hast du noch Interesse?`
            ]
        };

        const options = templates[type] || templates.nudge_1;
        return options[Math.floor(Math.random() * options.length)];
    },

    /**
     * Queue follow-ups for all eligible contacts
     */
    queueAll: () => {
        const eligible = followup.checkAll();
        let queued = 0;

        for (const item of eligible) {
            const msg = followup.generateMessage(item.contact, item.messageType);
            queue.add(item.contact.phone, msg, 3);
            events.add(item.contact.phone, 'FOLLOWUP_QUEUED', {
                type: item.type,
                messageType: item.messageType,
                nudgeNumber: item.nudgeNumber || null,
                minutesAgo: item.minutesAgo || null,
                hoursAgo: item.hoursAgo || null
            });
            queued++;
        }

        return { queued, total: eligible.length };
    }
};

// ═══════════════ BOOKING FLOW (GERMAN) ═══════════════

const booking = {
    /**
     * Always direct to Calendly — no manual slot offers
     */
    offerSlots: (contact) => {
        const name = contact.name ? contact.name.split(' ')[0] : '';
        return {
            message: `Buch dir gerne einen Termin: https://calendly.com/vermoegensschutz_beratung/termin?back=1`,
            link: 'https://calendly.com/vermoegensschutz_beratung/termin?back=1'
        };
    },

    /**
     * Process booking confirmation
     */
    confirm: (phone, slot) => {
        contacts.setStage(phone, 'WON', 'Termin gebucht');
        events.add(phone, 'APPOINTMENT_BOOKED', { slot });
        
        return {
            confirmMessage: `Sehr gut, freue mich auf das Gespräch!`,
            reminderMessage: `Kurze Erinnerung an unser Gespräch, freue mich!`
        };
    },

    /**
     * Check if a message is a booking-related response (German + English)
     */
    isBookingResponse: (message) => {
        const lower = message.toLowerCase();
        const positiveSignals = [
            'ja', 'klar', 'gerne', 'passt', 'ok', 'gut', 'perfekt', 'mach ich',
            'termin', 'buchen', 'gebucht', 'kalendar', 'calendly',
            'yes', 'sure', 'book', 'sounds good'
        ];
        return positiveSignals.some(s => lower.includes(s));
    }
};

// ═══════════════ REJECTION COUNTER (3-STRIKE RULE) ═══════════════

const rejectionTracker = {
    /**
     * Count how many times a contact has rejected
     * Returns rejection count from conversation history
     */
    countRejections: (phone) => {
        const history = conversations.getByPhone(phone, 50);
        let rejections = 0;
        
        const rejectionPatterns = [
            'kein interesse', 'nicht interessiert', 'nein danke', 'nein', 'ne danke',
            'brauch ich nicht', 'will ich nicht', 'lass mich in ruhe', 'nicht für mich',
            'no thanks', 'not interested', 'no', 'stop', 'aufhören',
            'bitte nicht mehr', 'keine zeit', 'hab keine zeit'
        ];
        
        const hardRejectionPatterns = [
            'scam', 'betrug', 'abzocke', 'betrüger', 'spam', 'fick', 'scheiß',
            'verpiss', 'halt die fresse', 'block', 'anzeige', 'polizei'
        ];
        
        for (const msg of history) {
            if (msg.direction !== 'incoming') continue;
            const lower = msg.message.toLowerCase().trim();
            
            // Hard rejection = instant LOST
            if (hardRejectionPatterns.some(p => lower.includes(p))) {
                return { count: 999, isHardRejection: true };
            }
            
            // Soft rejection = count it
            if (rejectionPatterns.some(p => lower.includes(p))) {
                rejections++;
            }
        }
        
        return { count: rejections, isHardRejection: false };
    },

    /**
     * Check if we should give up on this contact
     * 3 soft rejections OR 1 hard rejection = LOST
     */
    shouldGiveUp: (phone) => {
        const { count, isHardRejection } = rejectionTracker.countRejections(phone);
        return isHardRejection || count >= 3;
    }
};

// ═══════════════ FINGERPRINT DETECTOR ═══════════════

const fingerprint = {
    /**
     * Check if a message is too similar to recently sent messages
     */
    isTooSimilar: (message, phone = null, threshold = 0.7) => {
        const recentOut = phone 
            ? conversations.getByPhone(phone, 50).filter(m => m.direction === 'outgoing')
            : [];

        if (recentOut.length === 0) return { similar: false };

        const msgShingles = fingerprint.getShingles(message);

        for (const prev of recentOut) {
            const prevShingles = fingerprint.getShingles(prev.message);
            const similarity = fingerprint.jaccardSimilarity(msgShingles, prevShingles);
            
            if (similarity > threshold) {
                return {
                    similar: true,
                    similarity: Math.round(similarity * 100),
                    matchedMessage: prev.message
                };
            }
        }

        return { similar: false };
    },

    getShingles: (text, n = 3) => {
        const clean = text.toLowerCase().replace(/[^a-z0-9 äöüß]/g, '').trim();
        const shingles = new Set();
        for (let i = 0; i <= clean.length - n; i++) {
            shingles.add(clean.substring(i, i + n));
        }
        return shingles;
    },

    jaccardSimilarity: (setA, setB) => {
        const intersection = new Set([...setA].filter(x => setB.has(x)));
        const union = new Set([...setA, ...setB]);
        return union.size === 0 ? 0 : intersection.size / union.size;
    }
};

module.exports = { followup, booking, fingerprint, rejectionTracker };
