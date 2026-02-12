/**
 * WhatsApp Messager - Main Application
 * AI-powered WhatsApp automation with human-like messaging
 */

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const chalk = require('chalk');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');

const { initializeDatabase, contacts, conversations, knowledge, queue, templates } = require('./database/db');
const { sendHumanLike, splitMessage, sleep, MAX_MESSAGE_LENGTH } = require('./humanizer');
const ai = require('./ai');
const { startServer, setWhatsAppClient } = require('./web/server');

// Configuration
const config = {
    autoReply: true,
    typingIndicator: true,
    maxMessageLength: MAX_MESSAGE_LENGTH,
    sessionTimeout: 30000
};

// Browser configuration
const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

let executablePath = null;
for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
        executablePath = p;
        break;
    }
}

// WhatsApp Client
let client = null;
let isReady = false;

/**
 * Initialize WhatsApp client
 */
function initializeClient() {
    client = new Client({
        authStrategy: new LocalAuth({
            clientId: 'whatsapp-messager-v2'
        }),
        puppeteer: {
            headless: false,
            executablePath: executablePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
        }
    });

    // QR Code event
    client.on('qr', (qr) => {
        console.log('\n' + chalk.cyan('========================================'));
        console.log(chalk.yellow('Scan this QR code with your WhatsApp app:'));
        console.log(chalk.gray('(WhatsApp > Settings > Linked Devices > Link a Device)'));
        console.log(chalk.cyan('========================================\n'));
        qrcode.generate(qr, { small: true });
    });

    // Ready event
    client.on('ready', () => {
        isReady = true;
        console.log(chalk.green('\n✅ WhatsApp client is ready!\n'));
        showMainMenu();
    });

    // Message received
    client.on('message', async (message) => {
        await handleIncomingMessage(message);
    });

    // Authentication events
    client.on('authenticated', () => {
        console.log(chalk.blue('🔐 Authentication successful!'));
    });

    client.on('auth_failure', (msg) => {
        console.error(chalk.red('❌ Authentication failed:'), msg);
    });

    client.on('disconnected', (reason) => {
        isReady = false;
        console.log(chalk.yellow('⚠️ Client disconnected:'), reason);
    });

    client.initialize();
}

/**
 * Handle incoming messages
 */
async function handleIncomingMessage(message) {
    const phone = message.from.replace('@c.us', '');
    const text = message.body;

    // Skip group messages
    if (message.from.includes('@g.us')) return;

    // Skip status messages
    if (message.isStatus) return;

    console.log(chalk.cyan(`\n📩 Message from ${phone}: ${text}`));

    // Save to conversations
    conversations.add(phone, text, 'incoming');

    // Update or create contact
    const contact = contacts.get(phone);
    if (!contact) {
        contacts.add(phone, null, null, null, 'Auto-added from incoming message');
    }

    // Auto-reply if enabled
    if (config.autoReply && ai.isAvailable()) {
        const contactData = contacts.get(phone);
        const response = await ai.generateResponse(phone, text, {
            contactName: contactData?.name,
            companyName: contactData?.company
        });

        if (response && response.length > 0) {
            // Send with human-like delay
            const chatId = `${phone}@c.us`;
            for (const msg of response) {
                await sleep(Math.random() * 5000 + 2000);
                await client.sendMessage(chatId, msg);
                conversations.add(phone, msg, 'outgoing');
                console.log(chalk.green(`📤 Auto-reply: ${msg}`));
            }
        }
    }
}

/**
 * Main menu
 */
async function showMainMenu() {
    while (true) {
        console.log(chalk.cyan('\n📱 WhatsApp Messager - Main Menu'));
        console.log(chalk.gray('─'.repeat(40)));

        const { action } = await inquirer.prompt([
            {
                type: 'list',
                name: 'action',
                message: 'What would you like to do?',
                choices: [
                    { name: '📤 Send Message', value: 'send' },
                    { name: '📇 Contact Manager', value: 'contacts' },
                    { name: '📚 Knowledge Base', value: 'knowledge' },
                    { name: '📝 Message Templates', value: 'templates' },
                    { name: '📊 View Conversations', value: 'conversations' },
                    { name: '⚙️  Settings', value: 'settings' },
                    { name: '❌ Exit', value: 'exit' }
                ]
            }
        ]);

        switch (action) {
            case 'send':
                await sendMessageMenu();
                break;
            case 'contacts':
                await contactManagerMenu();
                break;
            case 'knowledge':
                await knowledgeBaseMenu();
                break;
            case 'templates':
                await templatesMenu();
                break;
            case 'conversations':
                await viewConversationsMenu();
                break;
            case 'settings':
                await settingsMenu();
                break;
            case 'exit':
                console.log(chalk.yellow('\n👋 Goodbye!'));
                process.exit(0);
        }
    }
}

/**
 * Send message menu
 */
async function sendMessageMenu() {
    const { phone, message } = await inquirer.prompt([
        {
            type: 'input',
            name: 'phone',
            message: 'Enter phone number (with country code, no +):',
            validate: (input) => input.length > 0 ? true : 'Phone number is required'
        },
        {
            type: 'input',
            name: 'message',
            message: 'Enter message (can be longer than 70 chars, will be split):',
            validate: (input) => input.length > 0 ? true : 'Message is required'
        }
    ]);

    const contact = contacts.get(phone);
    const chatId = `${phone}@c.us`;

    console.log(chalk.yellow('\n📤 Sending message...'));
    
    if (message.length > MAX_MESSAGE_LENGTH) {
        const parts = splitMessage(message);
        console.log(chalk.gray(`Message will be sent in ${parts.length} parts:`));
        parts.forEach((p, i) => console.log(chalk.gray(`  ${i + 1}. "${p}"`)));
    }

    try {
        await sendHumanLike(client, chatId, message, (progress) => {
            if (progress.status === 'sent') {
                console.log(chalk.green(`  ✓ Part ${progress.part}/${progress.total}: "${progress.message}"`));
            }
        });

        // Save to conversations
        conversations.add(phone, message, 'outgoing');
        contacts.updateLastContacted(phone);
        
        console.log(chalk.green('\n✅ Message sent successfully!'));
    } catch (error) {
        console.log(chalk.red(`\n❌ Error: ${error.message}`));
    }
}

/**
 * Contact manager menu
 */
async function contactManagerMenu() {
    const { action } = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'Contact Manager',
            choices: [
                { name: '➕ Add Contact', value: 'add' },
                { name: '📋 List All Contacts', value: 'list' },
                { name: '🔍 Search Contacts', value: 'search' },
                { name: '✏️  Update Contact', value: 'update' },
                { name: '🔙 Back to Main Menu', value: 'back' }
            ]
        }
    ]);

    switch (action) {
        case 'add':
            const newContact = await inquirer.prompt([
                { type: 'input', name: 'phone', message: 'Phone number:', validate: (i) => i.length > 0 },
                { type: 'input', name: 'name', message: 'Name (optional):' },
                { type: 'input', name: 'company', message: 'Company (optional):' },
                { type: 'input', name: 'email', message: 'Email (optional):' },
                { type: 'input', name: 'notes', message: 'Notes (optional):' }
            ]);
            contacts.add(newContact.phone, newContact.name || null, newContact.company || null, 
                        newContact.email || null, newContact.notes || null);
            console.log(chalk.green('✅ Contact added!'));
            break;

        case 'list':
            const allContacts = contacts.getAll();
            if (allContacts.length === 0) {
                console.log(chalk.yellow('No contacts found.'));
            } else {
                console.log(chalk.cyan('\n📇 Contacts:'));
                allContacts.forEach(c => {
                    console.log(`  ${c.name || 'Unknown'} (${c.phone}) - ${c.company || 'No company'} [${c.status}]`);
                });
            }
            break;

        case 'search':
            const { query } = await inquirer.prompt([
                { type: 'input', name: 'query', message: 'Search term:' }
            ]);
            // Simple search implementation
            const results = contacts.getAll().filter(c => 
                c.name?.includes(query) || c.phone?.includes(query) || c.company?.includes(query)
            );
            console.log(chalk.cyan(`\nFound ${results.length} contacts:`));
            results.forEach(c => console.log(`  ${c.name || 'Unknown'} (${c.phone})`));
            break;

        case 'back':
            return;
    }
}

/**
 * Knowledge base menu
 */
async function knowledgeBaseMenu() {
    const { action } = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'Knowledge Base',
            choices: [
                { name: '➕ Add Knowledge', value: 'add' },
                { name: '📋 List All', value: 'list' },
                { name: '🔍 Search', value: 'search' },
                { name: '🗑️  Delete Entry', value: 'delete' },
                { name: '🔙 Back to Main Menu', value: 'back' }
            ]
        }
    ]);

    switch (action) {
        case 'add':
            const entry = await inquirer.prompt([
                { type: 'input', name: 'category', message: 'Category (e.g., pricing, services, faq):', validate: (i) => i.length > 0 },
                { type: 'input', name: 'answer', message: 'Answer/information:', validate: (i) => i.length > 0 },
                { type: 'input', name: 'question', message: 'Question (optional):' },
                { type: 'input', name: 'keywords', message: 'Keywords (comma-separated, optional):' }
            ]);
            knowledge.add(entry.category, entry.answer, entry.question || null, entry.keywords || null);
            console.log(chalk.green('✅ Knowledge added!'));
            break;

        case 'list':
            const allKnowledge = knowledge.getAll();
            if (allKnowledge.length === 0) {
                console.log(chalk.yellow('Knowledge base is empty.'));
            } else {
                console.log(chalk.cyan('\n📚 Knowledge Base:'));
                allKnowledge.forEach(k => {
                    console.log(`  [${k.category}] ${k.question || k.answer.substring(0, 50)}...`);
                });
            }
            break;

        case 'search':
            const { q } = await inquirer.prompt([
                { type: 'input', name: 'q', message: 'Search query:' }
            ]);
            const results = knowledge.search(q);
            console.log(chalk.cyan(`\nFound ${results.length} entries:`));
            results.forEach(k => console.log(`  [${k.category}] ${k.answer}`));
            break;

        case 'delete':
            const { id } = await inquirer.prompt([
                { type: 'input', name: 'id', message: 'Entry ID to delete:' }
            ]);
            knowledge.delete(parseInt(id));
            console.log(chalk.green('✅ Entry deleted!'));
            break;

        case 'back':
            return;
    }
}

/**
 * Templates menu
 */
async function templatesMenu() {
    const { action } = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'Message Templates',
            choices: [
                { name: '➕ Create Template', value: 'add' },
                { name: '📋 List Templates', value: 'list' },
                { name: '📤 Use Template', value: 'use' },
                { name: '🔙 Back to Main Menu', value: 'back' }
            ]
        }
    ]);

    switch (action) {
        case 'add':
            const template = await inquirer.prompt([
                { type: 'input', name: 'name', message: 'Template name:', validate: (i) => i.length > 0 },
                { type: 'input', name: 'content', message: 'Template content (use {name}, {company} as variables):', validate: (i) => i.length > 0 }
            ]);
            templates.add(template.name, template.content);
            console.log(chalk.green('✅ Template created!'));
            break;

        case 'list':
            const allTemplates = templates.getAll();
            if (allTemplates.length === 0) {
                console.log(chalk.yellow('No templates found.'));
            } else {
                console.log(chalk.cyan('\n📝 Templates:'));
                allTemplates.forEach(t => {
                    console.log(`  ${t.name}: ${t.content}`);
                });
            }
            break;

        case 'use':
            const templateList = templates.getAll();
            if (templateList.length === 0) {
                console.log(chalk.yellow('No templates available.'));
                return;
            }
            const { selectedTemplate, phone } = await inquirer.prompt([
                { 
                    type: 'list', 
                    name: 'selectedTemplate', 
                    message: 'Select template:',
                    choices: templateList.map(t => ({ name: t.name, value: t }))
                },
                { type: 'input', name: 'phone', message: 'Phone number:' }
            ]);
            
            const contact = contacts.get(phone);
            let content = selectedTemplate.content;
            content = content.replace('{name}', contact?.name || 'there');
            content = content.replace('{company}', contact?.company || '');
            
            const chatId = `${phone}@c.us`;
            await sendHumanLike(client, chatId, content);
            conversations.add(phone, content, 'outgoing');
            console.log(chalk.green('✅ Template sent!'));
            break;

        case 'back':
            return;
    }
}

/**
 * View conversations menu
 */
async function viewConversationsMenu() {
    const { phone } = await inquirer.prompt([
        { type: 'input', name: 'phone', message: 'Phone number to view conversations:' }
    ]);

    const history = conversations.getByPhone(phone);
    
    if (history.length === 0) {
        console.log(chalk.yellow('No conversations found for this number.'));
        return;
    }

    console.log(chalk.cyan(`\n💬 Conversation with ${phone}:`));
    console.log(chalk.gray('─'.repeat(40)));
    
    history.reverse().forEach(msg => {
        const time = new Date(msg.created_at).toLocaleString();
        const prefix = msg.direction === 'incoming' ? chalk.blue('📥') : chalk.green('📤');
        console.log(`${prefix} [${time}] ${msg.message}`);
    });
}

/**
 * Settings menu
 */
async function settingsMenu() {
    const { setting } = await inquirer.prompt([
        {
            type: 'list',
            name: 'setting',
            message: 'Settings',
            choices: [
                { name: `🤖 Auto-Reply: ${config.autoReply ? 'ON' : 'OFF'}`, value: 'autoReply' },
                { name: `⌨️  Typing Indicator: ${config.typingIndicator ? 'ON' : 'OFF'}`, value: 'typing' },
                { name: '🔙 Back to Main Menu', value: 'back' }
            ]
        }
    ]);

    switch (setting) {
        case 'autoReply':
            config.autoReply = !config.autoReply;
            console.log(chalk.green(`Auto-reply ${config.autoReply ? 'enabled' : 'disabled'}`));
            break;
        case 'typing':
            config.typingIndicator = !config.typingIndicator;
            console.log(chalk.green(`Typing indicator ${config.typingIndicator ? 'enabled' : 'disabled'}`));
            break;
        case 'back':
            return;
    }
}

/**
 * Start the application
 */
async function start() {
    console.log(chalk.cyan('\n📱 WhatsApp Messager v2.0'));
    console.log(chalk.gray('─'.repeat(40)));

    // Initialize database (async)
    await initializeDatabase();

    // Initialize AI
    ai.initializeAI();

    // Start web dashboard
    startServer();
    console.log(chalk.green('🌐 Dashboard available at: http://localhost:3000'));

    // Open dashboard in browser
    const open = require('child_process').exec;
    open('start http://localhost:3000');

    // Initialize WhatsApp client
    console.log(chalk.yellow('\n🔌 Connecting to WhatsApp...'));
    initializeClient();
    
    // Pass client to web server after initialization
    setTimeout(() => {
        if (client) {
            setWhatsAppClient(client);
        }
    }, 2000);
}

// Handle process termination
process.on('SIGINT', () => {
    console.log(chalk.yellow('\n\n👋 Shutting down...'));
    process.exit(0);
});

// Start the application
start();