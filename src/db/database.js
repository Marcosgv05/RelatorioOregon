import pg from 'pg';
import { logger } from '../config/logger.js';

const { Pool } = pg;

// Configuração do pool de conexões
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Testa conexão
pool.on('error', (err) => {
  logger.error('Erro no pool PostgreSQL:', err);
});

let isInitialized = false;

/**
 * Executa uma query no banco
 */
export async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 100) {
      logger.info(`Query lenta (${duration}ms): ${text.substring(0, 50)}...`);
    }
    return res;
  } catch (error) {
    logger.error(`Erro na query: ${error.message}`);
    throw error;
  }
}

/**
 * Inicializa as tabelas do banco de dados
 */
export async function initializeDatabase() {
  if (isInitialized) {
    return;
  }

  logger.info('🗄️ Inicializando banco de dados PostgreSQL...');

  try {
    // Tabela de usuários
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

    // Tabela de instâncias WhatsApp
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

    // Tabela de contatos
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

    // Tabela de mensagens
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

    // Tabela de métricas diárias
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

    // Tabela de credenciais WhatsApp
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

    // Índices para performance
    await query(`CREATE INDEX IF NOT EXISTS idx_contacts_instance ON contacts(instance_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_messages_instance ON messages(instance_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_daily_metrics_instance_date ON daily_metrics(instance_id, date)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_auth_state_session ON auth_state(session_id)`);

    isInitialized = true;
    logger.info('✅ Banco de dados PostgreSQL inicializado com sucesso!');
  } catch (error) {
    logger.error(`❌ Erro ao inicializar banco de dados: ${error.message}`);
    throw error;
  }
}

// ==================== USER QUERIES ====================
export const userQueries = {
  create: async (email, password, name, company) => {
    const result = await query(
      `INSERT INTO users (email, password, name, company) VALUES ($1, $2, $3, $4) RETURNING id`,
      [email, password, name, company]
    );
    return result.rows[0];
  },

  findByEmail: async (email) => {
    const result = await query(`SELECT * FROM users WHERE email = $1`, [email]);
    return result.rows[0];
  },

  findById: async (id) => {
    const result = await query(
      `SELECT id, email, name, company, created_at FROM users WHERE id = $1`,
      [id]
    );
    return result.rows[0];
  },

  updatePassword: async (id, password) => {
    await query(
      `UPDATE users SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
      [password, id]
    );
  }
};

// ==================== INSTANCE QUERIES ====================
export const instanceQueries = {
  create: async (id, userId, sessionId, name, phone, status) => {
    await query(
      `INSERT INTO instances (id, user_id, session_id, name, phone, status) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, sessionId, name, phone, status]
    );
  },

  findByUserId: async (userId) => {
    const result = await query(`SELECT * FROM instances WHERE user_id = $1`, [userId]);
    return result.rows;
  },

  findById: async (id) => {
    const result = await query(`SELECT * FROM instances WHERE id = $1`, [id]);
    return result.rows[0];
  },

  findBySessionId: async (sessionId) => {
    const result = await query(`SELECT * FROM instances WHERE session_id = $1`, [sessionId]);
    return result.rows[0];
  },

  updateStatus: async (status, phone, id) => {
    await query(
      `UPDATE instances SET status = $1, phone = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`,
      [status, phone, id]
    );
  },

  delete: async (id) => {
    await query(`DELETE FROM instances WHERE id = $1`, [id]);
  }
};

// ==================== CONTACT QUERIES ====================
export const contactQueries = {
  upsert: async (instanceId, phone, name, firstMessageAt, lastMessageAt) => {
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
  },

  findByInstanceId: async (instanceId) => {
    const result = await query(
      `SELECT * FROM contacts WHERE instance_id = $1 ORDER BY last_message_at DESC`,
      [instanceId]
    );
    return result.rows;
  },

  findByPhone: async (instanceId, phone) => {
    const result = await query(
      `SELECT * FROM contacts WHERE instance_id = $1 AND phone = $2`,
      [instanceId, phone]
    );
    return result.rows[0];
  },

  incrementReceived: async (id) => {
    await query(
      `UPDATE contacts SET total_messages_received = total_messages_received + 1 WHERE id = $1`,
      [id]
    );
  },

  incrementSent: async (id) => {
    await query(
      `UPDATE contacts SET total_messages_sent = total_messages_sent + 1 WHERE id = $1`,
      [id]
    );
  },

  incrementReturnCount: async (id) => {
    await query(
      `UPDATE contacts SET return_count = return_count + 1 WHERE id = $1`,
      [id]
    );
  },

  getActiveContacts: async (instanceId, limit) => {
    const result = await query(`
      SELECT c.*, 
             (SELECT COUNT(*) FROM messages m WHERE m.contact_id = c.id AND m.from_me = 1) as sent,
             (SELECT COUNT(*) FROM messages m WHERE m.contact_id = c.id AND m.from_me = 0) as received
      FROM contacts c
      WHERE c.instance_id = $1
      ORDER BY c.last_message_at DESC
      LIMIT $2
    `, [instanceId, limit]);
    return result.rows;
  }
};

// ==================== MESSAGE QUERIES ====================
export const messageQueries = {
  create: async (instanceId, contactId, messageId, fromMe, body, mediaType, timestamp) => {
    await query(`
      INSERT INTO messages (instance_id, contact_id, message_id, from_me, body, media_type, timestamp)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [instanceId, contactId, messageId, fromMe, body, mediaType, timestamp]);
  },

  findByContactId: async (contactId) => {
    const result = await query(
      `SELECT * FROM messages WHERE contact_id = $1 ORDER BY timestamp ASC`,
      [contactId]
    );
    return result.rows;
  },

  findByInstanceId: async (instanceId, limit) => {
    const result = await query(`
      SELECT m.*, c.phone, c.name as contact_name
      FROM messages m
      JOIN contacts c ON m.contact_id = c.id
      WHERE m.instance_id = $1
      ORDER BY m.timestamp DESC
      LIMIT $2
    `, [instanceId, limit]);
    return result.rows;
  },

  getConversation: async (contactId) => {
    const result = await query(
      `SELECT * FROM messages WHERE contact_id = $1 ORDER BY timestamp ASC`,
      [contactId]
    );
    return result.rows;
  },

  countByDateRange: async (instanceId, startDate, endDate) => {
    const result = await query(`
      SELECT DATE(timestamp) as date, 
             SUM(CASE WHEN from_me = 0 THEN 1 ELSE 0 END) as received,
             SUM(CASE WHEN from_me = 1 THEN 1 ELSE 0 END) as sent
      FROM messages 
      WHERE instance_id = $1 AND timestamp >= $2 AND timestamp <= $3
      GROUP BY DATE(timestamp)
      ORDER BY date ASC
    `, [instanceId, startDate, endDate]);
    return result.rows;
  }
};

// ==================== METRICS QUERIES ====================
export const metricsQueries = {
  upsertDaily: async (instanceId, date, newContacts, received, sent, returning) => {
    await query(`
      INSERT INTO daily_metrics (instance_id, date, new_contacts, total_messages_received, total_messages_sent, returning_contacts)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(instance_id, date) DO UPDATE SET
        new_contacts = daily_metrics.new_contacts + EXCLUDED.new_contacts,
        total_messages_received = daily_metrics.total_messages_received + EXCLUDED.total_messages_received,
        total_messages_sent = daily_metrics.total_messages_sent + EXCLUDED.total_messages_sent,
        returning_contacts = daily_metrics.returning_contacts + EXCLUDED.returning_contacts
    `, [instanceId, date, newContacts, received, sent, returning]);
  },

  getByDateRange: async (instanceId, startDate, endDate) => {
    const result = await query(`
      SELECT * FROM daily_metrics 
      WHERE instance_id = $1 AND date >= $2 AND date <= $3
      ORDER BY date ASC
    `, [instanceId, startDate, endDate]);
    return result.rows;
  },

  getToday: async (instanceId) => {
    const result = await query(`
      SELECT * FROM daily_metrics 
      WHERE instance_id = $1 AND date = CURRENT_DATE
    `, [instanceId]);
    return result.rows[0];
  }
};

// ==================== AUTH STATE QUERIES ====================
export const authStateQueries = {
  get: async (sessionId, dataKey) => {
    const result = await query(
      `SELECT data_value FROM auth_state WHERE session_id = $1 AND data_key = $2`,
      [sessionId, dataKey]
    );
    return result.rows[0];
  },

  set: async (sessionId, dataKey, dataValue) => {
    await query(`
      INSERT INTO auth_state (session_id, data_key, data_value)
      VALUES ($1, $2, $3)
      ON CONFLICT(session_id, data_key) DO UPDATE SET
        data_value = EXCLUDED.data_value,
        updated_at = CURRENT_TIMESTAMP
    `, [sessionId, dataKey, dataValue]);
  },

  delete: async (sessionId, dataKey) => {
    await query(
      `DELETE FROM auth_state WHERE session_id = $1 AND data_key = $2`,
      [sessionId, dataKey]
    );
  },

  deleteAll: async (sessionId) => {
    await query(`DELETE FROM auth_state WHERE session_id = $1`, [sessionId]);
  },

  getAll: async (sessionId) => {
    const result = await query(
      `SELECT data_key, data_value FROM auth_state WHERE session_id = $1`,
      [sessionId]
    );
    return result.rows;
  }
};

export default pool;
