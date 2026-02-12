/**
 * Database Module using sql.js (pure JavaScript SQLite)
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'whatsapp.db');

let db = null;
let SQL = null;

// Initialize database
async function initializeDatabase() {
    SQL = await initSqlJs();
    
    // Load existing database or create new one
    if (fs.existsSync(dbPath)) {
        const buffer = fs.readFileSync(dbPath);
        db = new SQL.Database(buffer);
    } else {
        db = new SQL.Database();
    }
    
    // Create tables
    db.run(`
        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT UNIQUE NOT NULL,
            name TEXT,
            company TEXT,
            email TEXT,
            status TEXT DEFAULT 'new',
            notes TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_contacted_at DATETIME
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_id INTEGER,
            phone TEXT NOT NULL,
            message TEXT NOT NULL,
            direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
            status TEXT DEFAULT 'sent',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS knowledge_base (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL,
            question TEXT,
            answer TEXT NOT NULL,
            keywords TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS campaigns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            status TEXT DEFAULT 'draft',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS scheduled_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_id INTEGER,
            phone TEXT NOT NULL,
            message TEXT NOT NULL,
            scheduled_for DATETIME,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            variables TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS message_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone TEXT NOT NULL,
            message TEXT NOT NULL,
            conversation_id INTEGER,
            priority INTEGER DEFAULT 5,
            status TEXT DEFAULT 'pending',
            scheduled_at DATETIME,
            sent_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    saveDatabase();
    console.log('✅ Database initialized successfully');
}

// Save database to file
function saveDatabase() {
    if (db) {
        const data = db.export();
        const buffer = Buffer.from(data);
        fs.writeFileSync(dbPath, buffer);
    }
}

// Helper function to get results as array of objects
function queryAll(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length > 0) {
        stmt.bind(params);
    }
    
    const results = [];
    while (stmt.step()) {
        const row = stmt.getAsObject();
        results.push(row);
    }
    stmt.free();
    return results;
}

// Helper function to get single result
function queryOne(sql, params = []) {
    const results = queryAll(sql, params);
    return results.length > 0 ? results[0] : null;
}

// Helper function to run query and return changes
function runQuery(sql, params = []) {
    db.run(sql, params);
    saveDatabase();
    return { changes: db.getRowsModified() };
}

// Contact operations
const contacts = {
    add: (phone, name = null, company = null, email = null, notes = null) => {
        try {
            runQuery(`
                INSERT OR IGNORE INTO contacts (phone, name, company, email, notes)
                VALUES (?, ?, ?, ?, ?)
            `, [phone, name, company, email, notes]);
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    },

    get: (phone) => {
        return queryOne('SELECT * FROM contacts WHERE phone = ?', [phone]);
    },

    getAll: () => {
        return queryAll('SELECT * FROM contacts ORDER BY created_at DESC');
    },

    getByStatus: (status) => {
        return queryAll('SELECT * FROM contacts WHERE status = ? ORDER BY created_at DESC', [status]);
    },

    update: (phone, updates) => {
        const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        const values = [...Object.values(updates), phone];
        runQuery(`UPDATE contacts SET ${fields} WHERE phone = ?`, values);
    },

    updateLastContacted: (phone) => {
        runQuery(`UPDATE contacts SET last_contacted_at = datetime('now') WHERE phone = ?`, [phone]);
    }
};

// Conversation operations
const conversations = {
    add: (phone, message, direction, status = 'sent') => {
        const contact = contacts.get(phone);
        const contactId = contact ? contact.id : null;
        runQuery(`
            INSERT INTO conversations (contact_id, phone, message, direction, status)
            VALUES (?, ?, ?, ?, ?)
        `, [contactId, phone, message, direction, status]);
        return { success: true };
    },

    getByPhone: (phone, limit = 50) => {
        return queryAll(`
            SELECT * FROM conversations 
            WHERE phone = ? 
            ORDER BY created_at DESC 
            LIMIT ?
        `, [phone, limit]);
    },

    getRecent: (phone, count = 5) => {
        const messages = queryAll(`
            SELECT * FROM conversations 
            WHERE phone = ? 
            ORDER BY created_at DESC 
            LIMIT ?
        `, [phone, count]);
        return messages.reverse();
    }
};

// Knowledge base operations
const knowledge = {
    add: (category, answer, question = null, keywords = null) => {
        runQuery(`
            INSERT INTO knowledge_base (category, question, answer, keywords)
            VALUES (?, ?, ?, ?)
        `, [category, question, answer, keywords]);
    },

    getAll: () => {
        return queryAll('SELECT * FROM knowledge_base ORDER BY category');
    },

    getByCategory: (category) => {
        return queryAll('SELECT * FROM knowledge_base WHERE category = ?', [category]);
    },

    search: (query) => {
        const searchTerm = `%${query}%`;
        return queryAll(`
            SELECT * FROM knowledge_base 
            WHERE keywords LIKE ? OR question LIKE ? OR answer LIKE ?
        `, [searchTerm, searchTerm, searchTerm]);
    },

    delete: (id) => {
        runQuery('DELETE FROM knowledge_base WHERE id = ?', [id]);
    }
};

// Message queue operations
const queue = {
    add: (phone, message, priority = 5) => {
        const delaySeconds = Math.floor(Math.random() * 10) + (priority * 3);
        runQuery(`
            INSERT INTO message_queue (phone, message, priority, scheduled_at)
            VALUES (?, ?, ?, datetime('now', '+' || ? || ' seconds'))
        `, [phone, message, priority, delaySeconds]);
    },

    getPending: () => {
        return queryAll(`
            SELECT * FROM message_queue 
            WHERE status = 'pending' AND scheduled_at <= datetime('now')
            ORDER BY priority ASC, created_at ASC
        `);
    },

    markSent: (id) => {
        runQuery(`UPDATE message_queue SET status = 'sent', sent_at = datetime('now') WHERE id = ?`, [id]);
    },

    clear: () => {
        runQuery("DELETE FROM message_queue WHERE status = 'sent'");
    }
};

// Templates operations
const templates = {
    add: (name, content, variables = null) => {
        runQuery(`
            INSERT INTO templates (name, content, variables)
            VALUES (?, ?, ?)
        `, [name, content, variables ? JSON.stringify(variables) : null]);
    },

    getAll: () => {
        return queryAll('SELECT * FROM templates ORDER BY name');
    },

    get: (id) => {
        return queryOne('SELECT * FROM templates WHERE id = ?', [id]);
    }
};

module.exports = {
    db: () => db,
    initializeDatabase,
    contacts,
    conversations,
    knowledge,
    queue,
    templates
};