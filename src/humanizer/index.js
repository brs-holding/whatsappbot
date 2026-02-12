/**
 * Humanizer Module
 * Makes messages appear more human-like by:
 * - Splitting long messages into shorter ones (max 70 chars)
 * - Adding random delays
 * - Simulating typing behavior
 */

const MAX_MESSAGE_LENGTH = 70;
const MIN_DELAY = 2000; // 2 seconds minimum
const MAX_DELAY = 8000; // 8 seconds maximum

/**
 * Split a long message into multiple shorter messages
 * Each message will be max 70 characters
 * Tries to split at natural break points (periods, commas, spaces)
 */
function splitMessage(text) {
    if (text.length <= MAX_MESSAGE_LENGTH) {
        return [text];
    }

    const messages = [];
    let remaining = text;

    while (remaining.length > 0) {
        if (remaining.length <= MAX_MESSAGE_LENGTH) {
            messages.push(remaining.trim());
            break;
        }

        // Try to find a good break point
        let breakPoint = -1;
        
        // Look for sentence end (period, exclamation, question mark)
        const sentenceEnd = remaining.lastIndexOf('.', MAX_MESSAGE_LENGTH);
        const exclEnd = remaining.lastIndexOf('!', MAX_MESSAGE_LENGTH);
        const questEnd = remaining.lastIndexOf('?', MAX_MESSAGE_LENGTH);
        
        breakPoint = Math.max(sentenceEnd, exclEnd, questEnd);
        
        // If no sentence end, look for comma
        if (breakPoint === -1 || breakPoint < MAX_MESSAGE_LENGTH / 2) {
            breakPoint = remaining.lastIndexOf(',', MAX_MESSAGE_LENGTH);
        }
        
        // If no comma, look for space
        if (breakPoint === -1 || breakPoint < MAX_MESSAGE_LENGTH / 2) {
            breakPoint = remaining.lastIndexOf(' ', MAX_MESSAGE_LENGTH);
        }
        
        // If no space, just cut at max length
        if (breakPoint === -1 || breakPoint < MAX_MESSAGE_LENGTH / 2) {
            breakPoint = MAX_MESSAGE_LENGTH;
        } else {
            breakPoint++; // Include the punctuation/space
        }

        const message = remaining.substring(0, breakPoint).trim();
        if (message.length > 0) {
            messages.push(message);
        }
        remaining = remaining.substring(breakPoint).trim();
    }

    return messages;
}

/**
 * Generate a random delay to simulate human typing
 * Returns delay in milliseconds
 */
function getRandomDelay(baseMultiplier = 1) {
    const delay = Math.floor(
        Math.random() * (MAX_DELAY - MIN_DELAY) + MIN_DELAY
    ) * baseMultiplier;
    return delay;
}

/**
 * Calculate delay based on message length
 * Longer messages = more typing time
 */
function getTypingDelay(message) {
    // Average human types ~40 WPM = ~200ms per character
    const baseTypingTime = message.length * 100;
    const randomVariance = Math.random() * 1000;
    const totalDelay = baseTypingTime + randomVariance;
    
    // Clamp between min and max
    return Math.max(MIN_DELAY, Math.min(totalDelay, MAX_DELAY * 2));
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Process a message for human-like sending
 * Returns an array of {message, delay} objects
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
 * Sends messages with natural delays between them
 */
async function sendHumanLike(client, chatId, text, onProgress = null) {
    const messageParts = humanizeMessage(text);
    const results = [];

    for (let i = 0; i < messageParts.length; i++) {
        const { message, delay, isLast } = messageParts[i];
        
        // Wait before sending
        if (onProgress) {
            onProgress({
                status: 'waiting',
                message: message,
                delay: delay,
                part: i + 1,
                total: messageParts.length
            });
        }
        
        await sleep(delay);
        
        // Simulate typing (if supported by client)
        try {
            const chat = await client.getChatById(chatId);
            if (chat.sendStateTyping) {
                await chat.sendStateTyping();
            }
        } catch (e) {
            // Typing indicator not supported, continue
        }
        
        // Send the message
        if (onProgress) {
            onProgress({
                status: 'sending',
                message: message,
                part: i + 1,
                total: messageParts.length
            });
        }
        
        const sent = await client.sendMessage(chatId, message);
        results.push(sent);
        
        if (onProgress) {
            onProgress({
                status: 'sent',
                message: message,
                part: i + 1,
                total: messageParts.length,
                isLast: isLast
            });
        }
    }

    return results;
}

/**
 * Add human-like quirks to a message
 * (Optional, for more realism)
 */
function addQuirks(message, options = {}) {
    const {
        lowercaseStart = false,    // Start with lowercase sometimes
        noPeriod = false,          // Skip period at end sometimes
        addEmoji = false           // Add occasional emoji
    } = options;

    let result = message;

    // Randomly lowercase first letter (informal style)
    if (lowercaseStart && Math.random() > 0.7) {
        result = result.charAt(0).toLowerCase() + result.slice(1);
    }

    // Randomly skip period at end
    if (noPeriod && Math.random() > 0.5) {
        result = result.replace(/[.!?]$/, '');
    }

    // Add emoji occasionally
    if (addEmoji && Math.random() > 0.8) {
        const emojis = ['👍', '😊', '👌', '🙌', '💪'];
        result = result + ' ' + emojis[Math.floor(Math.random() * emojis.length)];
    }

    return result;
}

module.exports = {
    splitMessage,
    getRandomDelay,
    getTypingDelay,
    humanizeMessage,
    sendHumanLike,
    addQuirks,
    sleep,
    MAX_MESSAGE_LENGTH
};