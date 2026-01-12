import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../config/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Caminho do banco de dados
const dbPath = path.join(process.cwd(), 'oregon.db');

// Cria conexão com o banco
const db = new Database(dbPath);

// Habilita modo WAL para melhor performance
db.pragma('journal_mode = WAL');

let isInitialized = false;

/**
 * Inicializa as tabelas do banco de dados
 */
export function initializeDatabase() {
  if (isInitialized) {
    return; // Já foi inicializado
  }
  
  logger.info('🗄️ Inicializando banco de dados...');

  // Tabela de usuários (clientes da agência)
  db.exec(`
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

  // Tabela de instâncias WhatsApp
  db.exec(`
    CREATE TABLE IF NOT EXISTS instances (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      session_id TEXT UNIQUE,
      name TEXT NOT NULL,
      phone TEXT,
      status TEXT DEFAULT 'disconnected',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Tabela de contatos
  db.exec(`
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
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE,
      UNIQUE(instance_id, phone)
    )
  `);

  // Tabela de mensagens
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      contact_id INTEGER NOT NULL,
      message_id TEXT,
      from_me INTEGER NOT NULL,
      body TEXT,
      media_type TEXT,
      timestamp DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE,
      FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
    )
  `);

  // Tabela de métricas diárias
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      date DATE NOT NULL,
      new_contacts INTEGER DEFAULT 0,
      total_messages_received INTEGER DEFAULT 0,
      total_messages_sent INTEGER DEFAULT 0,
      avg_response_time_seconds INTEGER DEFAULT 0,
      first_response_times TEXT DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE,
      UNIQUE(instance_id, date)
    )
  `);

  // Tabela de credenciais WhatsApp
  db.exec(`
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

  // Migrações: adiciona colunas que podem não existir em bancos antigos
  try {
    db.exec(`ALTER TABLE contacts ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`);
  } catch (e) {
    // Coluna já existe, ignora o erro
  }
  
  // Adiciona coluna para contar quantas vezes o contato retornou (follow receptivo)
  try {
    db.exec(`ALTER TABLE contacts ADD COLUMN return_count INTEGER DEFAULT 0`);
  } catch (e) {
    // Coluna já existe, ignora o erro
  }
  
  // Adiciona colunas para métricas de follow receptivo nas métricas diárias
  try {
    db.exec(`ALTER TABLE daily_metrics ADD COLUMN returning_contacts INTEGER DEFAULT 0`);
  } catch (e) {
    // Coluna já existe
  }

  // Índices para performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_contacts_instance ON contacts(instance_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
    CREATE INDEX IF NOT EXISTS idx_messages_instance ON messages(instance_id);
    CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_daily_metrics_instance_date ON daily_metrics(instance_id, date);
    CREATE INDEX IF NOT EXISTS idx_auth_state_session ON auth_state(session_id);
  `);

  isInitialized = true;
  logger.info('✅ Banco de dados inicializado com sucesso!');
}

// Inicializa o banco imediatamente quando o módulo é carregado
initializeDatabase();

// Funções auxiliares para usuários
export const userQueries = {
  create: db.prepare(`
    INSERT INTO users (email, password, name, company) 
    VALUES (?, ?, ?, ?)
  `),
  
  findByEmail: db.prepare(`
    SELECT * FROM users WHERE email = ?
  `),
  
  findById: db.prepare(`
    SELECT id, email, name, company, created_at FROM users WHERE id = ?
  `),
  
  updatePassword: db.prepare(`
    UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `)
};

// Funções auxiliares para instâncias
export const instanceQueries = {
  create: db.prepare(`
    INSERT INTO instances (id, user_id, session_id, name, phone, status)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  
  findByUserId: db.prepare(`
    SELECT * FROM instances WHERE user_id = ?
  `),
  
  findById: db.prepare(`
    SELECT * FROM instances WHERE id = ?
  `),
  
  findBySessionId: db.prepare(`
    SELECT * FROM instances WHERE session_id = ?
  `),
  
  updateStatus: db.prepare(`
    UPDATE instances SET status = ?, phone = ?, updated_at = CURRENT_TIMESTAMP 
    WHERE id = ?
  `),
  
  delete: db.prepare(`
    DELETE FROM instances WHERE id = ?
  `)
};

// Funções auxiliares para contatos
export const contactQueries = {
  upsert: db.prepare(`
    INSERT INTO contacts (instance_id, phone, name, first_message_at, last_message_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(instance_id, phone) DO UPDATE SET
      name = COALESCE(excluded.name, name),
      last_message_at = excluded.last_message_at,
      updated_at = CURRENT_TIMESTAMP
    RETURNING *
  `),
  
  findByInstanceId: db.prepare(`
    SELECT * FROM contacts WHERE instance_id = ? ORDER BY last_message_at DESC
  `),
  
  findByPhone: db.prepare(`
    SELECT * FROM contacts WHERE instance_id = ? AND phone = ?
  `),
  
  incrementReceived: db.prepare(`
    UPDATE contacts SET total_messages_received = total_messages_received + 1 WHERE id = ?
  `),
  
  incrementSent: db.prepare(`
    UPDATE contacts SET total_messages_sent = total_messages_sent + 1 WHERE id = ?
  `),
  
  incrementReturnCount: db.prepare(`
    UPDATE contacts SET return_count = return_count + 1 WHERE id = ?
  `),
  
  getActiveContacts: db.prepare(`
    SELECT c.*, 
           (SELECT COUNT(*) FROM messages m WHERE m.contact_id = c.id AND m.from_me = 1) as sent,
           (SELECT COUNT(*) FROM messages m WHERE m.contact_id = c.id AND m.from_me = 0) as received
    FROM contacts c
    WHERE c.instance_id = ?
    ORDER BY c.last_message_at DESC
    LIMIT ?
  `)
};

// Funções auxiliares para mensagens
export const messageQueries = {
  create: db.prepare(`
    INSERT INTO messages (instance_id, contact_id, message_id, from_me, body, media_type, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  
  findByContactId: db.prepare(`
    SELECT * FROM messages WHERE contact_id = ? ORDER BY timestamp ASC
  `),
  
  findByInstanceId: db.prepare(`
    SELECT m.*, c.phone, c.name as contact_name
    FROM messages m
    JOIN contacts c ON m.contact_id = c.id
    WHERE m.instance_id = ?
    ORDER BY m.timestamp DESC
    LIMIT ?
  `),
  
  getConversation: db.prepare(`
    SELECT * FROM messages WHERE contact_id = ? ORDER BY timestamp ASC
  `),
  
  countByDateRange: db.prepare(`
    SELECT DATE(timestamp) as date, 
           SUM(CASE WHEN from_me = 0 THEN 1 ELSE 0 END) as received,
           SUM(CASE WHEN from_me = 1 THEN 1 ELSE 0 END) as sent
    FROM messages 
    WHERE instance_id = ? AND timestamp >= ? AND timestamp <= ?
    GROUP BY DATE(timestamp)
    ORDER BY date ASC
  `)
};

// Funções auxiliares para métricas diárias
export const metricsQueries = {
  upsertDaily: db.prepare(`
    INSERT INTO daily_metrics (instance_id, date, new_contacts, total_messages_received, total_messages_sent, returning_contacts)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance_id, date) DO UPDATE SET
      new_contacts = new_contacts + excluded.new_contacts,
      total_messages_received = total_messages_received + excluded.total_messages_received,
      total_messages_sent = total_messages_sent + excluded.total_messages_sent,
      returning_contacts = returning_contacts + excluded.returning_contacts
  `),
  
  getByDateRange: db.prepare(`
    SELECT * FROM daily_metrics 
    WHERE instance_id = ? AND date >= ? AND date <= ?
    ORDER BY date ASC
  `),
  
  getToday: db.prepare(`
    SELECT * FROM daily_metrics 
    WHERE instance_id = ? AND date = DATE('now')
  `)
};

// Funções auxiliares para auth_state
export const authStateQueries = {
  get: db.prepare(`
    SELECT data_value FROM auth_state WHERE session_id = ? AND data_key = ?
  `),
  
  set: db.prepare(`
    INSERT INTO auth_state (session_id, data_key, data_value)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id, data_key) DO UPDATE SET
      data_value = excluded.data_value,
      updated_at = CURRENT_TIMESTAMP
  `),
  
  delete: db.prepare(`
    DELETE FROM auth_state WHERE session_id = ? AND data_key = ?
  `),
  
  deleteAll: db.prepare(`
    DELETE FROM auth_state WHERE session_id = ?
  `),
  
  getAll: db.prepare(`
    SELECT data_key, data_value FROM auth_state WHERE session_id = ?
  `)
};

export default db;
