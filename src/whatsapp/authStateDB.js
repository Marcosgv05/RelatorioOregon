import { authStateQueries } from '../db/database.js';
import { logger } from '../config/logger.js';
import { initAuthCreds, BufferJSON } from '@whiskeysockets/baileys';

/**
 * Usa o banco de dados PostgreSQL para armazenar o estado de autenticação do WhatsApp
 * @param {string} sessionId - ID da sessão
 */
export async function useDatabaseAuthState(sessionId) {

  const shouldIgnoreKey = (key) => {
    // Evita chaves que podem causar problemas de sync
    return key.startsWith('app-state-sync-key-') || key.startsWith('app-state-sync-version-');
  };

  const writeData = async (key, data) => {
    try {
      if (shouldIgnoreKey(key)) return;
      const value = JSON.stringify(data, BufferJSON.replacer);
      await authStateQueries.set(sessionId, key, value);
    } catch (error) {
      logger.error(`Erro ao salvar auth state [${key}]: ${error.message}`);
    }
  };

  const readData = async (key) => {
    try {
      const row = await authStateQueries.get(sessionId, key);
      return row ? JSON.parse(row.data_value, BufferJSON.reviver) : null;
    } catch (error) {
      logger.error(`Erro ao ler auth state [${key}]: ${error.message}`);
      return null;
    }
  };

  const removeData = async (key) => {
    try {
      await authStateQueries.delete(sessionId, key);
    } catch (error) {
      logger.error(`Erro ao remover auth state [${key}]: ${error.message}`);
    }
  };

  // Carrega ou cria credenciais
  let creds = await readData('creds');
  const credsLooksInvalid =
    !creds ||
    typeof creds !== 'object' ||
    !creds.noiseKey ||
    !creds.noiseKey.public ||
    !creds.noiseKey.private;

  if (credsLooksInvalid) {
    logger.warn(`Credenciais ausentes/inválidas para ${sessionId}. Recriando initAuthCreds().`);
    // Limpa tudo para evitar mistura de dados antigos
    try {
      await authStateQueries.deleteAll(sessionId);
    } catch (e) {
      // ignora
    }
    creds = initAuthCreds();
    // Persiste imediatamente
    await writeData('creds', creds);
  }

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          for (const id of ids) {
            const key = `${type}-${id}`;
            const value = await readData(key);
            data[id] = value;
          }
          return data;
        },
        set: async (data) => {
          for (const [category, categoryData] of Object.entries(data)) {
            for (const [id, value] of Object.entries(categoryData)) {
              const key = `${category}-${id}`;
              if (value) {
                await writeData(key, value);
              } else {
                await removeData(key);
              }
            }
          }
        }
      }
    },
    saveCreds: async () => {
      await writeData('creds', creds);
    }
  };
}

/**
 * Limpa todos os dados de autenticação de uma sessão
 * @param {string} sessionId - ID da sessão
 */
export async function clearAuthState(sessionId) {
  try {
    await authStateQueries.deleteAll(sessionId);
    logger.info(`Auth state limpo para sessão ${sessionId}`);
  } catch (error) {
    logger.error(`Erro ao limpar auth state: ${error.message}`);
    throw error;
  }
}

export default { useDatabaseAuthState, clearAuthState };
