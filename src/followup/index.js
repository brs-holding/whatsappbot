/**
 * Smart Follow-up Scheduler + Booking Flow
 * Behavior-based follow-ups + 2-slot appointment offers
 */

const { contacts, conversations, events, settings, queue } = require('../database/db');

// ═══════════════ FOLLOW-UP SCHEDULER ═══════════════

const followup = {
    /**
     * Check all contacts for follow-up opportunities
     * Returns list of contacts needing follow-up
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
     */
    check: (contact) => {
        const recent = conversations.getRecent(contact.phone, 5);
        if (recent.length === 0) return { needsFollowUp: false };

        const lastMsg = recent[recent.length - 1];
        const lastTime = new Date(lastMsg.created_at).getTime();
        const hoursAgo = (Date.now() - lastTime) / (1000 * 60 * 60);
        const maxFollowups = parseInt(settings.get('max_followups_without_reply') || '1');

        // Count our unanswered follow-ups
        let unansweredCount = 0;
        for (let i = recent.length - 1; i >= 0; i--) {
            if (recent[i].direction === 'outgoing') unansweredCount++;
            else break;
        }

        // Already hit max follow-ups
        if (unansweredCount >= maxFollowups + 1) {
            return { needsFollowUp: false, reason: 'max_followups_reached' };
        }

        // Last message was from them — no follow-up needed
        if (lastMsg.direction === 'incoming') {
            return { needsFollowUp: false, reason: 'waiting_for_our_reply' };
        }

        // ── Behavior-based triggers ──

        // Sent message, no reply for 6-18 hours
        if (lastMsg.direction === 'outgoing' && hoursAgo >= 6 && hoursAgo <= 48) {
            return {
                needsFollowUp: true,
                type: 'no_reply',
                hoursAgo: Math.round(hoursAgo),
                messageType: hoursAgo < 18 ? 'micro_value_nudge' : 'one_question_reengage'
            };
        }

        // Short reply detection (last inbound was very short)
        const lastInbound = recent.filter(m => m.direction === 'incoming').pop();
        if (lastInbound) {
            const shortReplies = ['ok', 'nice', 'cool', 'thanks', 'thx', 'k', 'yes', 'no', 'maybe', 'later', 'sure'];
            const isShort = shortReplies.includes(lastInbound.message.toLowerCase().trim());
            if (isShort && lastMsg.direction === 'outgoing' && hoursAgo >= 2) {
                return {
                    needsFollowUp: true,
                    type: 'short_reply',
                    hoursAgo: Math.round(hoursAgo),
                    messageType: 'one_question_reengage'
                };
            }
        }

        return { needsFollowUp: false };
    },

    /**
     * Generate follow-up message based on type
     */
    generateMessage: (contact, type) => {
        const name = contact.name || '';
        const stage = contact.pipeline_stage || 'INTRO';

        const templates = {
            micro_value_nudge: [
                `Hey${name ? ' ' + name : ''}, just a quick thought for you`,
                `Quick question — still looking into this?`,
                `Wanted to share something relevant with you`,
                `Hey, did you get a chance to think about it?`
            ],
            one_question_reengage: [
                `What's the one thing holding you back?`,
                `Any questions I can help clear up?`,
                `Would it help if I shared more details?`,
                `What matters most to you in making a decision?`
            ]
        };

        const options = templates[type] || templates.micro_value_nudge;
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
            queue.add(item.contact.phone, msg, 3); // priority 3 for follow-ups
            events.add(item.contact.phone, 'FOLLOWUP_QUEUED', {
                type: item.type,
                messageType: item.messageType,
                hoursAgo: item.hoursAgo
            });
            queued++;
        }

        return { queued, total: eligible.length };
    }
};

// ═══════════════ BOOKING FLOW ═══════════════

const booking = {
    /**
     * Generate booking offer with 2 time slots
     */
    offerSlots: (contact) => {
        const now = new Date();
        const today = now.getHours() < 16; // If before 4pm, offer today

        let slot1, slot2;
        if (today) {
            slot1 = 'today at 6pm';
            slot2 = 'tomorrow at 11am';
        } else {
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const dayAfter = new Date(now);
            dayAfter.setDate(dayAfter.getDate() + 2);
            
            const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
            slot1 = `tomorrow at 11am`;
            slot2 = `${dayNames[dayAfter.getDay()]} at 2pm`;
        }

        const name = contact.name ? `, ${contact.name}` : '';
        return {
            message: `Great${name}! Would ${slot1} or ${slot2} work for a quick call?`,
            slot1,
            slot2
        };
    },

    /**
     * Process booking confirmation
     */
    confirm: (phone, slot) => {
        contacts.setStage(phone, 'WON', 'Booking confirmed');
        events.add(phone, 'APPOINTMENT_BOOKED', { slot });
        
        return {
            confirmMessage: `Perfect, you're booked for ${slot}! I'll send a reminder beforehand.`,
            reminderMessage: `Quick reminder — we have our call ${slot}. Looking forward to it!`
        };
    },

    /**
     * Check if a message is a booking-related response
     */
    isBookingResponse: (message) => {
        const lower = message.toLowerCase();
        const positiveSignals = ['yes', 'sure', 'ok', 'works', 'good', 'perfect', 'sounds good', 
                                  'let\'s do', 'book', 'schedule', 'today', 'tomorrow', 'morning', 'afternoon'];
        return positiveSignals.some(s => lower.includes(s));
    }
};

// ═══════════════ FINGERPRINT DETECTOR ═══════════════

const fingerprint = {
    /**
     * Check if a message is too similar to recently sent messages
     * Uses simple shingle-based similarity
     */
    isTooSimilar: (message, phone = null, threshold = 0.7) => {
        // Get recent outbound messages
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

    /**
     * Get character n-gram shingles from text
     */
    getShingles: (text, n = 3) => {
        const clean = text.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
        const shingles = new Set();
        for (let i = 0; i <= clean.length - n; i++) {
            shingles.add(clean.substring(i, i + n));
        }
        return shingles;
    },

    /**
     * Jaccard similarity between two sets
     */
    jaccardSimilarity: (setA, setB) => {
        const intersection = new Set([...setA].filter(x => setB.has(x)));
        const union = new Set([...setA, ...setB]);
        return union.size === 0 ? 0 : intersection.size / union.size;
    }
};

module.exports = { followup, booking, fingerprint };