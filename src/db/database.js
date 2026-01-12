import { logger } from '../config/logger.js';

// Detecta qual banco usar baseado na variável DATABASE_URL
const isPostgres = !!process.env.DATABASE_URL;

let db;
let query;

if (isPostgres) {
  // ==================== POSTGRESQL (Produção/Railway) ====================
  const pg = await import('pg');
  const { Pool } = pg.default;

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    logger.error('Erro no pool PostgreSQL:', err);
  });

  query = async (text, params) => {
    try {
      const res = await pool.query(text, params);
      return res;
    } catch (error) {
      logger.error(`Erro na query PG: ${error.message}`);
      throw error;
    }
  };

  db = pool;
  logger.info('Usando PostgreSQL (DATABASE_URL detectada)');

} else {
  // ==================== SQLITE (Local) ====================
  const Database = (await import('better-sqlite3')).default;
  const sqliteDb = new Database('oregon.db');
  sqliteDb.pragma('journal_mode = WAL');

  // Wrapper para simular interface do pg
  query = async (text, params = []) => {
    try {
      // Converte $1, $2... para ?
      let sqliteText = text;
      if (params && params.length > 0) {
        for (let i = params.length; i >= 1; i--) {
          sqliteText = sqliteText.replace(new RegExp(`\\$${i}`, 'g'), '?');
        }
      }

      // Detecta tipo de query
      const isSelect = sqliteText.trim().toUpperCase().startsWith('SELECT');
      const isInsertReturning = sqliteText.includes('RETURNING');

      if (isSelect) {
        const rows = sqliteDb.prepare(sqliteText).all(...params);
        return { rows };
      } else if (isInsertReturning) {
        // Remove RETURNING clause para SQLite
        const withoutReturning = sqliteText.replace(/RETURNING\s+\*/gi, '').replace(/RETURNING\s+\w+/gi, '');
        const info = sqliteDb.prepare(withoutReturning).run(...params);
        return { rows: [{ id: info.lastInsertRowid }] };
      } else {
        sqliteDb.prepare(sqliteText).run(...params);
        return { rows: [] };
      }
    } catch (error) {
      logger.error(`Erro na query SQLite: ${error.message}`);
      throw error;
    }
  };

  db = sqliteDb;
  logger.info('Usando SQLite local (oregon.db)');
}

let isInitialized = false;

/**
 * Inicializa as tabelas do banco de dados
 */
export async function initializeDatabase() {
  if (isInitialized) return;

  logger.info('Inicializando banco de dados...');

  try {
    if (isPostgres) {
      // PostgreSQL - usa SERIAL e ON CONFLICT
      await query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          email TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          name TEXT NOT NULL,
          company TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS instances (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_id TEXT UNIQUE,
          name TEXT NOT NULL,
          phone TEXT,
          status TEXT DEFAULT 'disconnected',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS contacts (
          id SERIAL PRIMARY KEY,
          instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
          phone TEXT NOT NULL,
          name TEXT,
          first_message_at TIMESTAMP,
          last_message_at TIMESTAMP,
          total_messages_received INTEGER DEFAULT 0,
          total_messages_sent INTEGER DEFAULT 0,
          is_lead INTEGER DEFAULT 1,
          return_count INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(instance_id, phone)
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
          contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
          message_id TEXT,
          from_me INTEGER NOT NULL,
          body TEXT,
          media_type TEXT,
          timestamp TIMESTAMP NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS daily_metrics (
          id SERIAL PRIMARY KEY,
          instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
          date DATE NOT NULL,
          new_contacts INTEGER DEFAULT 0,
          total_messages_received INTEGER DEFAULT 0,
          total_messages_sent INTEGER DEFAULT 0,
          returning_contacts INTEGER DEFAULT 0,
          avg_response_time_seconds INTEGER DEFAULT 0,
          first_response_times TEXT DEFAULT '[]',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(instance_id, date)
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS auth_state (
          id SERIAL PRIMARY KEY,
          session_id TEXT NOT NULL,
          data_key TEXT NOT NULL,
          data_value TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(session_id, data_key)
        )
      `);

      // Índices PostgreSQL
      await query(`CREATE INDEX IF NOT EXISTS idx_contacts_instance ON contacts(instance_id)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_auth_state_session ON auth_state(session_id)`);

    } else {
      // SQLite - usa INTEGER PRIMARY KEY e INSERT OR REPLACE
      await query(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          name TEXT NOT NULL,
          company TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS instances (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          session_id TEXT UNIQUE,
          name TEXT NOT NULL,
          phone TEXT,
          status TEXT DEFAULT 'disconnected',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS contacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id TEXT NOT NULL,
          phone TEXT NOT NULL,
          name TEXT,
          first_message_at DATETIME,
          last_message_at DATETIME,
          total_messages_received INTEGER DEFAULT 0,
          total_messages_sent INTEGER DEFAULT 0,
          is_lead INTEGER DEFAULT 1,
          return_count INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(instance_id, phone)
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id TEXT NOT NULL,
          contact_id INTEGER NOT NULL,
          message_id TEXT,
          from_me INTEGER NOT NULL,
          body TEXT,
          media_type TEXT,
          timestamp DATETIME NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS daily_metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          instance_id TEXT NOT NULL,
          date DATE NOT NULL,
          new_contacts INTEGER DEFAULT 0,
          total_messages_received INTEGER DEFAULT 0,
          total_messages_sent INTEGER DEFAULT 0,
          returning_contacts INTEGER DEFAULT 0,
          avg_response_time_seconds INTEGER DEFAULT 0,
          first_response_times TEXT DEFAULT '[]',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(instance_id, date)
        )
      `);

      await query(`
        CREATE TABLE IF NOT EXISTS auth_state (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          data_key TEXT NOT NULL,
          data_value TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(session_id, data_key)
        )
      `);

      // Índices SQLite
      await query(`CREATE INDEX IF NOT EXISTS idx_contacts_instance ON contacts(instance_id)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id)`);
      await query(`CREATE INDEX IF NOT EXISTS idx_auth_state_session ON auth_state(session_id)`);
    }

    isInitialized = true;
    logger.info('Banco de dados inicializado com sucesso!');
  } catch (error) {
    logger.error(`Erro ao inicializar banco de dados: ${error.message}`);
    throw error;
  }
}

// ==================== USER QUERIES ====================
export const userQueries = {
  create: async (email, password, name, company) => {
    if (isPostgres) {
      const result = await query(
        `INSERT INTO users (email, password, name, company) VALUES ($1, $2, $3, $4) RETURNING id`,
        [email, password, name, company]
      );
      return result.rows[0];
    } else {
      const result = await query(
        `INSERT INTO users (email, password, name, company) VALUES (?, ?, ?, ?)`,
        [email, password, name, company]
      );
      return result.rows[0];
    }
  },

  findByEmail: async (email) => {
    const result = await query(`SELECT * FROM users WHERE email = ${isPostgres ? '$1' : '?'}`, [email]);
    return result.rows[0];
  },

  findById: async (id) => {
    const result = await query(
      `SELECT id, email, name, company, created_at FROM users WHERE id = ${isPostgres ? '$1' : '?'}`,
      [id]
    );
    return result.rows[0];
  },

  updatePassword: async (id, password) => {
    await query(
      isPostgres
        ? `UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`
        : `UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [password, id]
    );
  }
};

// ==================== INSTANCE QUERIES ====================
export const instanceQueries = {
  create: async (id, userId, sessionId, name, phone, status) => {
    await query(
      isPostgres
        ? `INSERT INTO instances (id, user_id, session_id, name, phone, status) VALUES ($1, $2, $3, $4, $5, $6)`
        : `INSERT INTO instances (id, user_id, session_id, name, phone, status) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, userId, sessionId, name, phone, status]
    );
  },

  findByUserId: async (userId) => {
    const result = await query(
      `SELECT * FROM instances WHERE user_id = ${isPostgres ? '$1' : '?'}`,
      [userId]
    );
    return result.rows;
  },

  findAll: async () => {
    const result = await query(`SELECT * FROM instances ORDER BY created_at DESC`);
    return result.rows;
  },

  findById: async (id) => {
    const result = await query(`SELECT * FROM instances WHERE id = ${isPostgres ? '$1' : '?'}`, [id]);
    return result.rows[0];
  },

  findBySessionId: async (sessionId) => {
    const result = await query(`SELECT * FROM instances WHERE session_id = ${isPostgres ? '$1' : '?'}`, [sessionId]);
    return result.rows[0];
  },

  updateStatus: async (status, phone, id) => {
    await query(
      isPostgres
        ? `UPDATE instances SET status = $1, phone = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`
        : `UPDATE instances SET status = ?, phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [status, phone, id]
    );
  },

  delete: async (id) => {
    await query(`DELETE FROM instances WHERE id = ${isPostgres ? '$1' : '?'}`, [id]);
  }
};

// ==================== CONTACT QUERIES ====================
export const contactQueries = {
  upsert: async (instanceId, phone, name, firstMessageAt, lastMessageAt) => {
    if (isPostgres) {
      const result = await query(`
        INSERT INTO contacts (instance_id, phone, name, first_message_at, last_message_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(instance_id, phone) DO UPDATE SET
          name = COALESCE(EXCLUDED.name, contacts.name),
          last_message_at = EXCLUDED.last_message_at,
          updated_at = CURRENT_TIMESTAMP
        RETURNING *
      `, [instanceId, phone, name, firstMessageAt, lastMessageAt]);
      return result.rows[0];
    } else {
      // SQLite: INSERT OR REPLACE
      await query(`
        INSERT INTO contacts (instance_id, phone, name, first_message_at, last_message_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(instance_id, phone) DO UPDATE SET
          name = COALESCE(excluded.name, name),
          last_message_at = excluded.last_message_at,
          updated_at = CURRENT_TIMESTAMP
      `, [instanceId, phone, name, firstMessageAt, lastMessageAt]);
      const result = await query(`SELECT * FROM contacts WHERE instance_id = ? AND phone = ?`, [instanceId, phone]);
      return result.rows[0];
    }
  },

  findByInstanceId: async (instanceId) => {
    const result = await query(
      `SELECT * FROM contacts WHERE instance_id = ${isPostgres ? '$1' : '?'} ORDER BY last_message_at DESC`,
      [instanceId]
    );
    return result.rows;
  },

  findByPhone: async (instanceId, phone) => {
    const result = await query(
      isPostgres
        ? `SELECT * FROM contacts WHERE instance_id = $1 AND phone = $2`
        : `SELECT * FROM contacts WHERE instance_id = ? AND phone = ?`,
      [instanceId, phone]
    );
    return result.rows[0];
  },

  incrementReceived: async (id) => {
    await query(
      `UPDATE contacts SET total_messages_received = total_messages_received + 1 WHERE id = ${isPostgres ? '$1' : '?'}`,
      [id]
    );
  },

  incrementSent: async (id) => {
    await query(
      `UPDATE contacts SET total_messages_sent = total_messages_sent + 1 WHERE id = ${isPostgres ? '$1' : '?'}`,
      [id]
    );
  },

  incrementReturnCount: async (id) => {
    await query(
      `UPDATE contacts SET return_count = return_count + 1 WHERE id = ${isPostgres ? '$1' : '?'}`,
      [id]
    );
  },

  getActiveContacts: async (instanceId, limit) => {
    const result = await query(isPostgres ? `
      SELECT c.*, 
             (SELECT COUNT(*) FROM messages m WHERE m.contact_id = c.id AND m.from_me = 1) as sent,
             (SELECT COUNT(*) FROM messages m WHERE m.contact_id = c.id AND m.from_me = 0) as received
      FROM contacts c
      WHERE c.instance_id = $1
      ORDER BY c.last_message_at DESC
      LIMIT $2
    ` : `
      SELECT c.*, 
             (SELECT COUNT(*) FROM messages m WHERE m.contact_id = c.id AND m.from_me = 1) as sent,
             (SELECT COUNT(*) FROM messages m WHERE m.contact_id = c.id AND m.from_me = 0) as received
      FROM contacts c
      WHERE c.instance_id = ?
      ORDER BY c.last_message_at DESC
      LIMIT ?
    `, [instanceId, limit]);
    return result.rows;
  }
};

// ==================== MESSAGE QUERIES ====================
export const messageQueries = {
  create: async (instanceId, contactId, messageId, fromMe, body, mediaType, timestamp) => {
    await query(isPostgres ? `
      INSERT INTO messages (instance_id, contact_id, message_id, from_me, body, media_type, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    ` : `
      INSERT INTO messages (instance_id, contact_id, message_id, from_me, body, media_type, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [instanceId, contactId, messageId, fromMe, body, mediaType, timestamp]);
  },

  findByContactId: async (contactId) => {
    const result = await query(
      `SELECT * FROM messages WHERE contact_id = ${isPostgres ? '$1' : '?'} ORDER BY timestamp ASC`,
      [contactId]
    );
    return result.rows;
  },

  findByInstanceId: async (instanceId, limit) => {
    const result = await query(isPostgres ? `
      SELECT m.*, c.phone, c.name as contact_name
      FROM messages m
      JOIN contacts c ON m.contact_id = c.id
      WHERE m.instance_id = $1
      ORDER BY m.timestamp DESC
      LIMIT $2
    ` : `
      SELECT m.*, c.phone, c.name as contact_name
      FROM messages m
      JOIN contacts c ON m.contact_id = c.id
      WHERE m.instance_id = ?
      ORDER BY m.timestamp DESC
      LIMIT ?
    `, [instanceId, limit]);
    return result.rows;
  },

  getConversation: async (contactId) => {
    const result = await query(
      `SELECT * FROM messages WHERE contact_id = ${isPostgres ? '$1' : '?'} ORDER BY timestamp ASC`,
      [contactId]
    );
    return result.rows;
  },

  countByDateRange: async (instanceId, startDate, endDate) => {
    // Adiciona horário para garantir comparação correta
    const startDateTime = startDate + 'T00:00:00.000Z';
    const endDateTime = endDate + 'T23:59:59.999Z';

    const result = await query(isPostgres ? `
      SELECT DATE(timestamp) as date, 
             SUM(CASE WHEN from_me = 0 THEN 1 ELSE 0 END) as received,
             SUM(CASE WHEN from_me = 1 THEN 1 ELSE 0 END) as sent
      FROM messages 
      WHERE instance_id = $1 AND timestamp >= $2 AND timestamp <= $3
      GROUP BY DATE(timestamp)
      ORDER BY date ASC
    ` : `
      SELECT DATE(timestamp) as date, 
             SUM(CASE WHEN from_me = 0 THEN 1 ELSE 0 END) as received,
             SUM(CASE WHEN from_me = 1 THEN 1 ELSE 0 END) as sent
      FROM messages 
      WHERE instance_id = ? AND timestamp >= ? AND timestamp <= ?
      GROUP BY DATE(timestamp)
      ORDER BY date ASC
    `, [instanceId, startDateTime, endDateTime]);
    return result.rows;
  }
};

// ==================== METRICS QUERIES ====================
export const metricsQueries = {
  upsertDaily: async (instanceId, date, newContacts, received, sent, returning) => {
    await query(isPostgres ? `
      INSERT INTO daily_metrics (instance_id, date, new_contacts, total_messages_received, total_messages_sent, returning_contacts)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(instance_id, date) DO UPDATE SET
        new_contacts = daily_metrics.new_contacts + EXCLUDED.new_contacts,
        total_messages_received = daily_metrics.total_messages_received + EXCLUDED.total_messages_received,
        total_messages_sent = daily_metrics.total_messages_sent + EXCLUDED.total_messages_sent,
        returning_contacts = daily_metrics.returning_contacts + EXCLUDED.returning_contacts
    ` : `
      INSERT INTO daily_metrics (instance_id, date, new_contacts, total_messages_received, total_messages_sent, returning_contacts)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(instance_id, date) DO UPDATE SET
        new_contacts = daily_metrics.new_contacts + excluded.new_contacts,
        total_messages_received = daily_metrics.total_messages_received + excluded.total_messages_received,
        total_messages_sent = daily_metrics.total_messages_sent + excluded.total_messages_sent,
        returning_contacts = daily_metrics.returning_contacts + excluded.returning_contacts
    `, [instanceId, date, newContacts, received, sent, returning]);
  },

  getByDateRange: async (instanceId, startDate, endDate) => {
    const result = await query(isPostgres ? `
      SELECT * FROM daily_metrics 
      WHERE instance_id = $1 AND date >= $2 AND date <= $3
      ORDER BY date ASC
    ` : `
      SELECT * FROM daily_metrics 
      WHERE instance_id = ? AND date >= ? AND date <= ?
      ORDER BY date ASC
    `, [instanceId, startDate, endDate]);
    return result.rows;
  },

  getToday: async (instanceId) => {
    const result = await query(isPostgres ? `
      SELECT * FROM daily_metrics 
      WHERE instance_id = $1 AND date = CURRENT_DATE
    ` : `
      SELECT * FROM daily_metrics 
      WHERE instance_id = ? AND date = DATE('now')
    `, [instanceId]);
    return result.rows[0];
  }
};

// ==================== AUTH STATE QUERIES ====================
export const authStateQueries = {
  get: async (sessionId, dataKey) => {
    const result = await query(
      isPostgres
        ? `SELECT data_value FROM auth_state WHERE session_id = $1 AND data_key = $2`
        : `SELECT data_value FROM auth_state WHERE session_id = ? AND data_key = ?`,
      [sessionId, dataKey]
    );
    return result.rows[0];
  },

  set: async (sessionId, dataKey, dataValue) => {
    await query(isPostgres ? `
      INSERT INTO auth_state (session_id, data_key, data_value)
      VALUES ($1, $2, $3)
      ON CONFLICT(session_id, data_key) DO UPDATE SET
        data_value = EXCLUDED.data_value,
        updated_at = CURRENT_TIMESTAMP
    ` : `
      INSERT INTO auth_state (session_id, data_key, data_value)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id, data_key) DO UPDATE SET
        data_value = excluded.data_value,
        updated_at = CURRENT_TIMESTAMP
    `, [sessionId, dataKey, dataValue]);
  },

  delete: async (sessionId, dataKey) => {
    await query(
      isPostgres
        ? `DELETE FROM auth_state WHERE session_id = $1 AND data_key = $2`
        : `DELETE FROM auth_state WHERE session_id = ? AND data_key = ?`,
      [sessionId, dataKey]
    );
  },

  deleteAll: async (sessionId) => {
    await query(
      `DELETE FROM auth_state WHERE session_id = ${isPostgres ? '$1' : '?'}`,
      [sessionId]
    );
  },

  getAll: async (sessionId) => {
    const result = await query(
      isPostgres
        ? `SELECT data_key, data_value FROM auth_state WHERE session_id = $1`
        : `SELECT data_key, data_value FROM auth_state WHERE session_id = ?`,
      [sessionId]
    );
    return result.rows;
  }
};

export { query, isPostgres };
export default db;
