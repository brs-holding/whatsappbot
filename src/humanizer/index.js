/**
 * Humanizer Module
 * Makes messages appear more human-like
 * NO aggressive splitting — send complete, natural messages
 * URLs are NEVER split
 */

const MAX_MESSAGE_LENGTH = 500; // Full messages, not fragments
const MIN_DELAY = 2000;
const MAX_DELAY = 8000;

/**
 * Split message ONLY if it's very long (500+ chars)
 * NEVER splits URLs
 * A human sends complete thoughts in one message
 */
function splitMessage(text) {
    // Most messages should go as-is (1-2 sentences = under 500 chars)
    if (text.length <= MAX_MESSAGE_LENGTH) {
        return [text];
    }

    // For very long messages, split at sentence boundaries
    const messages = [];
    const sentences = text.split(/(?<=[.!?])\s+/);
    let current = '';

    for (const sentence of sentences) {
        // If adding this sentence would exceed limit, push current and start new
        if (current.length + sentence.length + 1 > MAX_MESSAGE_LENGTH && current.length > 0) {
            messages.push(current.trim());
            current = sentence;
        } else {
            current += (current ? ' ' : '') + sentence;
        }
    }
    if (current.trim()) messages.push(current.trim());

    // If we still have nothing, just return the whole text as one message
    return messages.length > 0 ? messages : [text];
}

/**
 * Generate a random delay to simulate human typing
 */
function getRandomDelay(baseMultiplier = 1) {
    return Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY) + MIN_DELAY) * baseMultiplier;
}

/**
 * Calculate delay based on message length
 */
function getTypingDelay(message) {
    const baseTypingTime = message.length * 80;
    const randomVariance = Math.random() * 1000;
    return Math.max(MIN_DELAY, Math.min(baseTypingTime + randomVariance, MAX_DELAY * 2));
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process a message for human-like sending
 */
function humanizeMessage(text) {
    const messages = splitMessage(text);
    return messages.map((msg, index) => ({
        message: msg,
        delay: index === 0 ? getRandomDelay(0.5) : getTypingDelay(msg),
        isLast: index === messages.length - 1
    }));
}

/**
 * Human-like message sender
 */
async function sendHumanLike(client, chatId, text, onProgress = null) {
    const messageParts = humanizeMessage(text);
    const results = [];

    for (let i = 0; i < messageParts.length; i++) {
        const { message, delay, isLast } = messageParts[i];
        
        await sleep(delay);
        
        // Simulate typing
        try {
            const chat = await client.getChatById(chatId);
            if (chat.sendStateTyping) await chat.sendStateTyping();
        } catch (e) {}
        
        const sent = await client.sendMessage(chatId, message);
        results.push(sent);
    }

    return results;
}

module.exports = {
    splitMessage,
    getRandomDelay,
    getTypingDelay,
    humanizeMessage,
    sendHumanLike,
    sleep,
    MAX_MESSAGE_LENGTH
};