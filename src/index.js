/**
 * WhatsApp Messager v3.0 — Production Sales Operator
 * Safety Core + Pipeline + CCB + Consent + Human Handoff
 */

require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const chalk = require('chalk');
const fs = require('fs');

const { initializeDatabase, contacts, conversations, events, settings, uuid } = require('./database/db');
const { sendHumanLike, splitMessage, sleep } = require('./humanizer');
const ai = require('./ai');
const { killSwitch, validator, consent, escalation } = require('./safety');
const { initPipeline, processMessage, generateCCB } = require('./pipeline');
const { followup, booking, fingerprint } = require('./followup');
const { initOutreach } = require('./outreach');
const { startServer, setWhatsAppClient, setQRCode } = require('./web/server');

// Browser config
const browserPaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const executablePath = browserPaths.find(p => fs.existsSync(p)) || null;

let client = null;

// ═══════════════ WHATSAPP CLIENT ═══════════════
function initializeClient() {
    client = new Client({
        authStrategy: new LocalAuth({ clientId: 'whatsapp-messager-v3' }),
        puppeteer: { headless: false, executablePath, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'] }
    });

    client.on('qr', (qr) => {
        setQRCode(qr);
        console.log(chalk.yellow('\n📱 Scan QR code at http://localhost:3000 or in Chrome window\n'));
        qrcode.generate(qr, { small: true });
    });

    client.on('ready', () => {
        console.log(chalk.green('\n✅ WhatsApp connected!\n'));
        console.log(chalk.cyan('🌐 Dashboard: http://localhost:3000'));
        console.log(chalk.gray('📊 Pipeline active | 🛡️ Safety enabled | 🤖 AI ready\n'));
    });

    client.on('message', async (msg) => {
        try { await handleIncomingMessage(msg); }
        catch (e) { console.error(chalk.red('❌ Message handler error:'), e.message); killSwitch.recordError(); }
    });

    client.on('authenticated', () => console.log(chalk.blue('🔐 Authenticated')));
    client.on('auth_failure', (m) => console.error(chalk.red('❌ Auth failed:'), m));
    client.on('disconnected', (r) => console.log(chalk.yellow('⚠️ Disconnected:'), r));

    client.initialize();
}

// ═══════════════ MESSAGE HANDLER (production pipeline) ═══════════════
async function handleIncomingMessage(message) {
    // Skip groups, status, LID format, broadcasts
    if (message.from.includes('@g.us') || message.isStatus) return;
    if (message.from.includes('@lid') || message.from.includes('@broadcast')) return;
    if (!message.from.includes('@c.us')) return;

    const phone = message.from.replace('@c.us', '');
    const text = (message.body || '').trim();
    const chatId = `${phone}@c.us`;

    // Skip empty messages (media without text, stickers, etc.)
    if (!text || text.length === 0) {
        console.log(chalk.gray(`   ⏭️ [${phone}] Skipped empty message (media/sticker)`));
        return;
    }

    console.log(chalk.cyan(`\n📩 [${phone}] ${text}`));

    // Log inbound event
    events.add(phone, 'INBOUND_MESSAGE', { message: text });
    conversations.add(phone, text, 'incoming');

    // Auto-add contact if new
    if (!contacts.get(phone)) {
        contacts.add(phone, null, null, null, 'Auto-added from inbound');
    }
    contacts.updateLastInbound(phone);

    // ── Step 1: Consent check ──
    const consentResult = consent.processInbound(phone, text);
    if (consentResult.action === 'dnd_set') {
        await safeSend(chatId, phone, consentResult.reply);
        console.log(chalk.yellow(`🚫 [${phone}] DND set`));
        return;
    }

    // ── Step 2: Escalation check ──
    const escResult = escalation.check(text);
    if (escResult.escalate) {
        escalation.execute(phone, escResult.triggers);
        await safeSend(chatId, phone, escResult.holdingReply);
        console.log(chalk.red(`🚨 [${phone}] ESCALATED: ${escResult.triggers.map(t => t.type).join(', ')}`));
        return;
    }

    // ── Step 3: Check if bot is paused for this contact ──
    const contact = contacts.get(phone);
    if (contact?.bot_paused || contact?.human_required) {
        console.log(chalk.yellow(`⏸️ [${phone}] Bot paused / human required — skipping auto-reply`));
        return;
    }

    // ── Step 4: Auto-reply check ──
    if (!settings.isAutoReplyEnabled()) return;

    // ── Step 5: Run pipeline (intent + stage + CCB) ──
    const pipelineResult = await processMessage(phone, text);
    console.log(chalk.gray(`   Intent: ${pipelineResult.intent?.intent} | Stage: ${pipelineResult.previousStage} → ${pipelineResult.currentStage}`));

    // ── Step 6: Generate AI response ──
    if (ai.isAvailable()) {
        const contactData = contacts.get(phone);
        const ccb = contactData?.ccb ? JSON.parse(contactData.ccb) : null;

        const response = await ai.generateResponse(phone, text, {
            contactName: contactData?.name,
            companyName: contactData?.company,
            stage: pipelineResult.currentStage,
            ccb: ccb?.conclusion
        });

        if (response && response.length > 0) {
            for (const msg of response) {
                await safeSend(chatId, phone, msg, pipelineResult.runId);
            }
        }
    }

    killSwitch.recordSuccess();
}

// ═══════════════ SAFE SEND (with all gates) ═══════════════
async function safeSend(chatId, phone, message, runId = null) {
    // Gate 1: Kill switch
    const canSend = killSwitch.canSend(phone);
    if (!canSend.allowed) {
        console.log(chalk.yellow(`🚫 Send blocked: ${canSend.reason}`));
        events.add(phone, 'SEND_BLOCKED', { reason: canSend.reason, message });
        return false;
    }

    // Gate 2: Validate content
    const validation = validator.validate(message, { phone });
    if (!validation.valid) {
        console.log(chalk.red(`❌ Validator blocked: ${validation.violations.map(v => v.rule).join(', ')}`));
        events.add(phone, 'VALIDATION_FAILED', { violations: validation.violations, message });
        return false;
    }

    // Gate 3: Fingerprint check (anti-repetition)
    const fpCheck = fingerprint.isTooSimilar(message, phone);
    if (fpCheck.similar) {
        console.log(chalk.yellow(`⚠️ Fingerprint: ${fpCheck.similarity}% similar — logged`));
        events.add(phone, 'FINGERPRINT_FLAGGED', { similarity: fpCheck.similarity });
    }

    // Gate 4: Send with human-like delay
    try {
        await sleep(Math.random() * 4000 + 1500);
        await client.sendMessage(chatId, message);
        
        conversations.add(phone, message, 'outgoing', runId);
        contacts.updateLastContacted(phone);
        events.add(phone, 'OUTBOUND_MESSAGE', { message, run_id: runId });
        
        console.log(chalk.green(`   📤 [${phone}] ${message}`));
        return true;
    } catch (e) {
        killSwitch.recordError();
        events.add(phone, 'SEND_ERROR', { error: e.message, message });
        console.error(chalk.red(`   ❌ Send failed: ${e.message}`));
        return false;
    }
}

// ═══════════════ START ═══════════════
async function start() {
    console.log(chalk.cyan('\n📱 WhatsApp Messager v3.0 — Production Sales Operator'));
    console.log(chalk.gray('━'.repeat(55)));

    await initializeDatabase();
    ai.initializeAI();
    initPipeline();
    initOutreach();

    startServer();
    console.log(chalk.green('🌐 Dashboard: http://localhost:3000'));
    console.log(chalk.green('🛡️  Safety: Kill switch + Validator + Escalation'));
    console.log(chalk.green('📊 Pipeline: Intent → Stage → CCB'));
    console.log(chalk.green('🚀 Outreach: Opener variations ready'));

    require('child_process').exec('start http://localhost:3000');

    console.log(chalk.yellow('\n🔌 Connecting to WhatsApp...'));
    initializeClient();

    setTimeout(() => { if (client) setWhatsAppClient(client); }, 2000);
}

process.on('SIGINT', () => { console.log(chalk.yellow('\n👋 Shutting down...')); process.exit(0); });
start();