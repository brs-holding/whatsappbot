/**
 * Database Module v2 - Production Schema
 * Events, Consent, Pipeline, CCB support
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'whatsapp.db');
let db = null;

function uuid() { return crypto.randomUUID(); }

async function initializeDatabase() {
    const SQL = await initSqlJs();
    db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();

    // ── Contacts (extended) ──
    db.run(`CREATE TABLE IF NOT EXISTS contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT UNIQUE NOT NULL,
        name TEXT, company TEXT, email TEXT, notes TEXT,
        status TEXT DEFAULT 'new',
        consent_status TEXT DEFAULT 'UNKNOWN',
        pipeline_stage TEXT DEFAULT 'INTRO',
        stage_reason TEXT,
        batch_id TEXT, batch_type TEXT, pitch_project TEXT, source_context TEXT,
        priority_score INTEGER DEFAULT 50,
        risk_score INTEGER DEFAULT 0,
        ccb TEXT,
        bot_paused INTEGER DEFAULT 0,
        human_required INTEGER DEFAULT 0,
        language TEXT DEFAULT 'en',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_contacted_at DATETIME,
        last_inbound_at DATETIME
    )`);

    // ── Conversations ──
    db.run(`CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id INTEGER, phone TEXT NOT NULL,
        message TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
        status TEXT DEFAULT 'sent',
        run_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // ── Events (append-only timeline) ──
    db.run(`CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        contact_id INTEGER, phone TEXT,
        event_type TEXT NOT NULL,
        payload TEXT,
        run_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // ── Knowledge Packages (versioned) ──
    db.run(`CREATE TABLE IF NOT EXISTS knowledge_packages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        package_name TEXT NOT NULL,
        version INTEGER DEFAULT 1,
        content TEXT NOT NULL,
        do_not_say TEXT,
        approved_by TEXT, approved_at DATETIME,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // ── Knowledge Base (backward compat) ──
    db.run(`CREATE TABLE IF NOT EXISTS knowledge_base (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL, question TEXT, answer TEXT NOT NULL,
        keywords TEXT, package_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // ── Templates ──
    db.run(`CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, content TEXT NOT NULL, variables TEXT,
        pitch_project TEXT, stage TEXT, step_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // ── Settings (kill switch, config) ──
    db.run(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY, value TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // ── Message Queue ──
    db.run(`CREATE TABLE IF NOT EXISTS message_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT NOT NULL, message TEXT NOT NULL,
        priority INTEGER DEFAULT 5, status TEXT DEFAULT 'pending',
        scheduled_at DATETIME, sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Default settings
    const defaults = {
        'global_send_enabled': 'true',
        'auto_reply_enabled': 'true',
        'max_followups_without_reply': '1',
        'cooldown_days': '30',
        'max_chars_per_message': '420',
        'link_policy': 'no_links_until_engagement'
    };
    for (const [k, v] of Object.entries(defaults)) {
        db.run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`, [k, v]);
    }

    save();
    console.log('✅ Database initialized (v2 schema)');
}

function save() {
    if (db) fs.writeFileSync(dbPath, Buffer.from(db.export()));
}

function queryAll(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const results = [];
    while (stmt.step()) results.push(stmt.getAsObject());
    stmt.free();
    return results;
}

function queryOne(sql, params = []) {
    const r = queryAll(sql, params);
    return r.length ? r[0] : null;
}

function run(sql, params = []) {
    db.run(sql, params);
    save();
}

// ═══════════════ CONTACTS ═══════════════
const contacts = {
    add: (phone, name, company, email, notes, extra = {}) => {
        const { batch_id, batch_type, pitch_project, source_context, consent_status } = extra;
        run(`INSERT OR IGNORE INTO contacts
            (phone, name, company, email, notes, batch_id, batch_type, pitch_project, source_context, consent_status)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [phone, name, company, email, notes,
             batch_id || null, batch_type || null, pitch_project || null,
             source_context || null, consent_status || 'UNKNOWN']);
    },
    get: (phone) => queryOne('SELECT * FROM contacts WHERE phone = ?', [phone]),
    getAll: () => queryAll('SELECT * FROM contacts ORDER BY created_at DESC'),
    getByStatus: (status) => queryAll('SELECT * FROM contacts WHERE status = ?', [status]),
    getByStage: (stage) => queryAll('SELECT * FROM contacts WHERE pipeline_stage = ?', [stage]),
    getByConsent: (consent) => queryAll('SELECT * FROM contacts WHERE consent_status = ?', [consent]),
    getByBatch: (batchId) => queryAll('SELECT * FROM contacts WHERE batch_id = ?', [batchId]),
    getHumanRequired: () => queryAll('SELECT * FROM contacts WHERE human_required = 1'),
    update: (phone, updates) => {
        const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        run(`UPDATE contacts SET ${fields} WHERE phone = ?`, [...Object.values(updates), phone]);
    },
    updateLastContacted: (phone) => run(`UPDATE contacts SET last_contacted_at = datetime('now') WHERE phone = ?`, [phone]),
    updateLastInbound: (phone) => run(`UPDATE contacts SET last_inbound_at = datetime('now') WHERE phone = ?`, [phone]),
    setStage: (phone, stage, reason) => {
        run(`UPDATE contacts SET pipeline_stage = ?, stage_reason = ? WHERE phone = ?`, [stage, reason, phone]);
        events.add(phone, 'STAGE_CHANGED', { stage, reason });
    },
    setConsent: (phone, status) => {
        run(`UPDATE contacts SET consent_status = ? WHERE phone = ?`, [status, phone]);
        events.add(phone, 'CONSENT_CHANGED', { consent_status: status });
    },
    setCCB: (phone, ccb) => run(`UPDATE contacts SET ccb = ? WHERE phone = ?`, [JSON.stringify(ccb), phone]),
    getCCB: (phone) => {
        const c = queryOne('SELECT ccb FROM contacts WHERE phone = ?', [phone]);
        return c && c.ccb ? JSON.parse(c.ccb) : null;
    },
    pauseBot: (phone) => { run(`UPDATE contacts SET bot_paused = 1 WHERE phone = ?`, [phone]); events.add(phone, 'BOT_PAUSED', {}); },
    resumeBot: (phone) => { run(`UPDATE contacts SET bot_paused = 0 WHERE phone = ?`, [phone]); events.add(phone, 'BOT_RESUMED', {}); },
    setHumanRequired: (phone, required) => {
        run(`UPDATE contacts SET human_required = ? WHERE phone = ?`, [required ? 1 : 0, phone]);
        if (required) events.add(phone, 'HUMAN_TAKEOVER', {});
    },
    setDND: (phone) => {
        run(`UPDATE contacts SET consent_status = 'DND', bot_paused = 1 WHERE phone = ?`, [phone]);
        events.add(phone, 'DND_SET', {});
    },
    isSendAllowed: (phone) => {
        const c = queryOne('SELECT consent_status, bot_paused, human_required FROM contacts WHERE phone = ?', [phone]);
        if (!c) return true;
        if (c.consent_status === 'DND') return false;
        if (c.bot_paused) return false;
        if (c.human_required) return false;
        return true;
    }
};

// ═══════════════ CONVERSATIONS ═══════════════
const conversations = {
    add: (phone, message, direction, runId = null) => {
        const contact = contacts.get(phone);
        run(`INSERT INTO conversations (contact_id, phone, message, direction, run_id)
            VALUES (?,?,?,?,?)`,
            [contact?.id || null, phone, message, direction, runId]);
    },
    getByPhone: (phone, limit = 50) => queryAll(
        'SELECT * FROM conversations WHERE phone = ? ORDER BY created_at DESC LIMIT ?', [phone, limit]),
    getRecent: (phone, count = 10) => {
        const msgs = queryAll('SELECT * FROM conversations WHERE phone = ? ORDER BY created_at DESC LIMIT ?', [phone, count]);
        return msgs.reverse();
    }
};

// ═══════════════ EVENTS (append-only) ═══════════════
const events = {
    add: (phone, eventType, payload = {}) => {
        const contact = contacts.get(phone);
        const id = uuid();
        run(`INSERT INTO events (id, contact_id, phone, event_type, payload, run_id)
            VALUES (?,?,?,?,?,?)`,
            [id, contact?.id || null, phone, eventType, JSON.stringify(payload), payload.run_id || null]);
        return id;
    },
    getByPhone: (phone, limit = 100) => queryAll(
        'SELECT * FROM events WHERE phone = ? ORDER BY created_at DESC LIMIT ?', [phone, limit]),
    getByType: (eventType, limit = 50) => queryAll(
        'SELECT * FROM events WHERE event_type = ? ORDER BY created_at DESC LIMIT ?', [eventType, limit]),
    getRecent: (limit = 50) => queryAll(
        'SELECT * FROM events ORDER BY created_at DESC LIMIT ?', [limit])
};

// ═══════════════ KNOWLEDGE ═══════════════
const knowledge = {
    add: (category, answer, question, keywords) => run(
        `INSERT INTO knowledge_base (category, question, answer, keywords) VALUES (?,?,?,?)`,
        [category, question, answer, keywords]),
    getAll: () => queryAll('SELECT * FROM knowledge_base ORDER BY category'),
    search: (query) => {
        const t = `%${query}%`;
        return queryAll('SELECT * FROM knowledge_base WHERE keywords LIKE ? OR question LIKE ? OR answer LIKE ?', [t, t, t]);
    },
    delete: (id) => run('DELETE FROM knowledge_base WHERE id = ?', [id])
};

// ═══════════════ TEMPLATES ═══════════════
const templates = {
    add: (name, content, vars) => run(
        `INSERT INTO templates (name, content, variables) VALUES (?,?,?)`,
        [name, content, vars ? JSON.stringify(vars) : null]),
    getAll: () => queryAll('SELECT * FROM templates ORDER BY name'),
    get: (id) => queryOne('SELECT * FROM templates WHERE id = ?', [id]),
    getByProject: (project) => queryAll('SELECT * FROM templates WHERE pitch_project = ? ORDER BY step_order', [project])
};

// ═══════════════ SETTINGS (kill switch etc) ═══════════════
const settings = {
    get: (key) => { const r = queryOne('SELECT value FROM settings WHERE key = ?', [key]); return r ? r.value : null; },
    set: (key, value) => run(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))`, [key, value]),
    getAll: () => queryAll('SELECT * FROM settings'),
    isGlobalSendEnabled: () => settings.get('global_send_enabled') === 'true',
    isAutoReplyEnabled: () => settings.get('auto_reply_enabled') === 'true'
};

// ═══════════════ MESSAGE QUEUE ═══════════════
const queue = {
    add: (phone, message, priority = 5) => run(
        `INSERT INTO message_queue (phone, message, priority) VALUES (?,?,?)`, [phone, message, priority]),
    getPending: () => queryAll(`SELECT * FROM message_queue WHERE status = 'pending' ORDER BY priority ASC, created_at ASC`),
    markSent: (id) => run(`UPDATE message_queue SET status = 'sent', sent_at = datetime('now') WHERE id = ?`, [id])
};

module.exports = {
    db: () => db, initializeDatabase,
    contacts, conversations, events, knowledge, templates, settings, queue, uuid
};