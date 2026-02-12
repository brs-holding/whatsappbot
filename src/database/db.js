const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'whatsapp.db');
const db = new Database(dbPath);

// Initialize database schema
function initializeDatabase() {
    // Contacts table
    db.exec(`
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

    // Conversations table - stores all messages
    db.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_id INTEGER,
            phone TEXT NOT NULL,
            message TEXT NOT NULL,
            direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
            status TEXT DEFAULT 'sent',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (contact_id) REFERENCES contacts(id)
        )
    `);

    // Knowledge base table
    db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_base (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            category TEXT NOT NULL,
            question TEXT,
            answer TEXT NOT NULL,
            keywords TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Campaigns table
    db.exec(`
        CREATE TABLE IF NOT EXISTS campaigns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT,
            status TEXT DEFAULT 'draft',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Scheduled messages table
    db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_id INTEGER,
            phone TEXT NOT NULL,
            message TEXT NOT NULL,
            scheduled_for DATETIME,
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (contact_id) REFERENCES contacts(id)
        )
    `);

    // Message templates table
    db.exec(`
        CREATE TABLE IF NOT EXISTS templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            variables TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Message queue table - for human-like sending
    db.exec(`
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

    console.log('✅ Database initialized successfully');
}

// Contact operations
const contacts = {
    add: (phone, name = null, company = null, email = null, notes = null) => {
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO contacts (phone, name, company, email, notes)
            VALUES (?, ?, ?, ?, ?)
        `);
        return stmt.run(phone, name, company, email, notes);
    },

    get: (phone) => {
        const stmt = db.prepare('SELECT * FROM contacts WHERE phone = ?');
        return stmt.get(phone);
    },

    getAll: () => {
        const stmt = db.prepare('SELECT * FROM contacts ORDER BY created_at DESC');
        return stmt.all();
    },

    getByStatus: (status) => {
        const stmt = db.prepare('SELECT * FROM contacts WHERE status = ? ORDER BY created_at DESC');
        return stmt.all(status);
    },

    update: (phone, updates) => {
        const fields = Object.keys(updates).map(k => `${k} = ?`).join(', ');
        const values = [...Object.values(updates), phone];
        const stmt = db.prepare(`UPDATE contacts SET ${fields} WHERE phone = ?`);
        return stmt.run(...values);
    },

    updateLastContacted: (phone) => {
        const stmt = db.prepare(`
            UPDATE contacts SET last_contacted_at = CURRENT_TIMESTAMP WHERE phone = ?
        `);
        return stmt.run(phone);
    }
};

// Conversation operations
const conversations = {
    add: (phone, message, direction, status = 'sent') => {
        const contact = contacts.get(phone);
        const contactId = contact ? contact.id : null;
        
        const stmt = db.prepare(`
            INSERT INTO conversations (contact_id, phone, message, direction, status)
            VALUES (?, ?, ?, ?, ?)
        `);
        return stmt.run(contactId, phone, message, direction, status);
    },

    getByPhone: (phone, limit = 50) => {
        const stmt = db.prepare(`
            SELECT * FROM conversations 
            WHERE phone = ? 
            ORDER BY created_at DESC 
            LIMIT ?
        `);
        return stmt.all(phone, limit);
    },

    getRecent: (phone, count = 5) => {
        const stmt = db.prepare(`
            SELECT * FROM conversations 
            WHERE phone = ? 
            ORDER BY created_at DESC 
            LIMIT ?
        `);
        const messages = stmt.all(phone, count);
        return messages.reverse(); // Return in chronological order
    }
};

// Knowledge base operations
const knowledge = {
    add: (category, answer, question = null, keywords = null) => {
        const stmt = db.prepare(`
            INSERT INTO knowledge_base (category, question, answer, keywords)
            VALUES (?, ?, ?, ?)
        `);
        return stmt.run(category, question, answer, keywords);
    },

    getAll: () => {
        const stmt = db.prepare('SELECT * FROM knowledge_base ORDER BY category');
        return stmt.all();
    },

    getByCategory: (category) => {
        const stmt = db.prepare('SELECT * FROM knowledge_base WHERE category = ?');
        return stmt.all(category);
    },

    search: (query) => {
        const stmt = db.prepare(`
            SELECT * FROM knowledge_base 
            WHERE keywords LIKE ? OR question LIKE ? OR answer LIKE ?
        `);
        const searchTerm = `%${query}%`;
        return stmt.all(searchTerm, searchTerm, searchTerm);
    },

    delete: (id) => {
        const stmt = db.prepare('DELETE FROM knowledge_base WHERE id = ?');
        return stmt.run(id);
    }
};

// Message queue operations
const queue = {
    add: (phone, message, priority = 5) => {
        const stmt = db.prepare(`
            INSERT INTO message_queue (phone, message, priority, scheduled_at)
            VALUES (?, ?, ?, datetime('now', '+' || ? || ' seconds'))
        `);
        // Calculate delay based on priority (higher priority = less delay)
        const delaySeconds = Math.floor(Math.random() * 10) + (priority * 3);
        return stmt.run(phone, message, priority, delaySeconds);
    },

    getPending: () => {
        const stmt = db.prepare(`
            SELECT * FROM message_queue 
            WHERE status = 'pending' AND scheduled_at <= CURRENT_TIMESTAMP
            ORDER BY priority ASC, created_at ASC
        `);
        return stmt.all();
    },

    markSent: (id) => {
        const stmt = db.prepare(`
            UPDATE message_queue SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?
        `);
        return stmt.run(id);
    },

    clear: () => {
        const stmt = db.prepare("DELETE FROM message_queue WHERE status = 'sent'");
        return stmt.run();
    }
};

// Templates operations
const templates = {
    add: (name, content, variables = null) => {
        const stmt = db.prepare(`
            INSERT INTO templates (name, content, variables)
            VALUES (?, ?, ?)
        `);
        return stmt.run(name, content, variables ? JSON.stringify(variables) : null);
    },

    getAll: () => {
        const stmt = db.prepare('SELECT * FROM templates ORDER BY name');
        return stmt.all();
    },

    get: (id) => {
        const stmt = db.prepare('SELECT * FROM templates WHERE id = ?');
        return stmt.get(id);
    }
};

module.exports = {
    db,
    initializeDatabase,
    contacts,
    conversations,
    knowledge,
    queue,
    templates
};