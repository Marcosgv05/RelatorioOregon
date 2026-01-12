import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import { logger } from '../config/logger.js';
import { useDatabaseAuthState, clearAuthState } from './authStateDB.js';
import { messageQueries } from '../db/database.js';

/**
 * Gerenciador de sessões WhatsApp para o RelatorioOregon
 * Adaptado do projeto Arauto com foco em monitoramento de conversas
 */
class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.messageReceivedCallbacks = [];
    this.connectionCallbacks = [];
    this.reconnectState = new Map();
    this.reconnectTimers = new Map();
    this.qrCodeState = new Map();
    // Quando estoura o limite de QR, pausamos reconexões automáticas até o usuário clicar "Conectar" de novo
    this.qrLoopPaused = new Set(); // sessionId
  }

  /**
   * Registra callback para mensagens recebidas
   */
  onMessageReceived(callback) {
    this.messageReceivedCallbacks.push(callback);
  }

  /**
   * Registra callback para mudanças de conexão
   */
  onConnectionUpdate(callback) {
    this.connectionCallbacks.push(callback);
  }

  /**
   * Cria uma nova sessão do WhatsApp
   */
  async createSession(sessionId, options = {}) {
    const { forceNew = false } = options;

    if (!sessionId) {
      throw new Error('sessionId é obrigatório');
    }

    // Se o usuário pediu para conectar de novo, "despausa" a sessão e reseta contadores/timers
    this.qrLoopPaused.delete(sessionId);
    this.qrCodeState.delete(sessionId);
    this.reconnectState.delete(sessionId);
    const existingTimer = this.reconnectTimers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.reconnectTimers.delete(sessionId);
    }

    // Remove sessão existente se forceNew
    if (forceNew && this.sessions.has(sessionId)) {
      await this.removeSession(sessionId);
    } else if (this.sessions.has(sessionId)) {
      const existingSession = this.sessions.get(sessionId);
      if (existingSession?.isReady && existingSession?.sock?.user) {
        logger.info(`Sessão ${sessionId} já está ativa`);
        return existingSession.sock;
      }

      // Limpa sessão antiga não funcional
      try {
        existingSession?.sock?.end?.();
        existingSession?.sock?.ws?.close?.();
      } catch (e) {
        // Ignora erros
      }
      this.sessions.delete(sessionId);
    }

    try {
      logger.info(`📱 Criando sessão: ${sessionId}`);

      if (forceNew) {
        await clearAuthState(sessionId);
      }

      const { state, saveCreds } = await useDatabaseAuthState(sessionId);
      const { version } = await fetchLatestBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: logger.child({ session: sessionId }),
        browser: ['RelatorioOregon', 'Chrome', '10'],
        getMessage: async (key) => {
          try {
            logger.info(`[getMessage] Buscando mensagem: ${key.id} para ${key.remoteJid}`);

            // Busca a mensagem no banco de dados usando o message_id
            const messages = messageQueries.findByContactId.all(key.remoteJid?.replace('@s.whatsapp.net', '') || '');
            logger.info(`[getMessage] Encontradas ${messages.length} mensagens para o contato`);

            const message = messages.find(m => m.message_id === key.id);

            if (message && message.body) {
              logger.info(`[getMessage] Mensagem encontrada com conteúdo: "${message.body}"`);
              return {
                key: key,
                message: {
                  conversation: message.body,
                  extendedTextMessage: message.body ? { text: message.body } : undefined
                },
                messageTimestamp: new Date(message.timestamp).getTime() / 1000,
                status: 'SERVER_ACK'
              };
            }

            logger.info(`[getMessage] Mensagem não encontrada ou sem conteúdo para ${key.id}`);
            return undefined;
          } catch (error) {
            logger.error(`Erro ao buscar mensagem ${key.id}: ${error.message}`);
            return undefined;
          }
        },
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        keepAliveIntervalMs: 20000,
        connectTimeoutMs: 180000,
        defaultQueryTimeoutMs: 90000,
        markOnlineOnConnect: true
      });

      // Salva credenciais
      sock.ev.on('creds.update', saveCreds);

      // Ignora sincronização de histórico
      sock.ev.on('messaging-history.set', () => {
        logger.info(`Ignorando sincronização de histórico para ${sessionId}`);
      });

      // Evento de mensagens recebidas (IMPORTANTE para analytics)
      sock.ev.on('messages.upsert', ({ messages, type }) => {
        logger.info(`📨 messages.upsert recebido: type=${type}, count=${messages?.length || 0}`);

        if (type !== 'notify') {
          logger.info(`⏭️ Ignorando mensagens (type=${type}, não é 'notify')`);
          return;
        }

        logger.info(`📨 Processando ${messages.length} mensagens do tipo 'notify':`);

        for (const msg of messages) {
          const phone = msg.key.remoteJid?.replace('@s.whatsapp.net', '');

          logger.info(`📩 Mensagem: de=${phone}, fromMe=${msg.key.fromMe}, id=${msg.key?.id}, type=${msg.key.remoteJid}`);

          if (!phone || phone.includes('@g.us')) {
            logger.info(`⏭️ Ignorando: ${!phone ? 'sem telefone' : 'é grupo'}`);
            continue;
          }

          const contactName = msg.pushName || null;

          // Extrai texto da mensagem
          const messageBody = this.extractMessageBody(msg.message);

          // Ignora mensagens sem conteúdo (evita criar mensagens automáticas)
          if (!messageBody || messageBody.trim() === '') {
            logger.info(`⏭️ Ignorando mensagem sem conteúdo: ${phone}, fromMe=${msg.key.fromMe}`);
            continue;
          }

          logger.info(`💬 Processando: ${phone} (${contactName || 'sem nome'}): "${messageBody?.substring(0, 50) || '[sem texto]'}"`);

          // Notifica todos os callbacks
          logger.info(`📤 Notificando ${this.messageReceivedCallbacks.length} callback(s)`);

          this.messageReceivedCallbacks.forEach(cb => {
            try {
              cb(sessionId, phone, {
                messageId: msg.key?.id,
                fromMe: msg.key.fromMe,
                body: messageBody,
                timestamp: new Date(msg.messageTimestamp * 1000).toISOString(),
                contactName,
                mediaType: this.getMediaType(msg.message)
              });
              logger.info(`✅ Callback executado com sucesso`);
            } catch (error) {
              logger.error(`❌ Erro em callback de mensagem: ${error.message}`);
            }
          });
        }
      });

      // Evento de conexão
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          this.handleQRCode(sessionId, qr, sock);
        }

        if (connection === 'close') {
          await this.handleDisconnect(sessionId, lastDisconnect);
        } else if (connection === 'open') {
          this.handleConnect(sessionId, sock);
        }
      });

      this.sessions.set(sessionId, {
        sock,
        isReady: false,
        lastUsed: Date.now()
      });

      return sock;
    } catch (error) {
      logger.error(`Erro ao criar sessão ${sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Extrai o corpo da mensagem de diferentes tipos
   */
  extractMessageBody(message) {
    if (!message) return '';

    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    if (message.documentMessage?.caption) return message.documentMessage.caption;
    if (message.buttonsResponseMessage?.selectedDisplayText) return message.buttonsResponseMessage.selectedDisplayText;
    if (message.listResponseMessage?.title) return message.listResponseMessage.title;

    // Tipos de mídia sem texto
    if (message.imageMessage) return '[📷 Imagem]';
    if (message.videoMessage) return '[🎥 Vídeo]';
    if (message.audioMessage) return '[🎵 Áudio]';
    if (message.documentMessage) return '[📄 Documento]';
    if (message.stickerMessage) return '[😀 Sticker]';
    if (message.locationMessage) return '[📍 Localização]';
    if (message.contactMessage) return '[👤 Contato]';

    return '';
  }

  /**
   * Identifica o tipo de mídia da mensagem
   */
  getMediaType(message) {
    if (!message) return 'text';
    if (message.imageMessage) return 'image';
    if (message.videoMessage) return 'video';
    if (message.audioMessage) return 'audio';
    if (message.documentMessage) return 'document';
    if (message.stickerMessage) return 'sticker';
    if (message.locationMessage) return 'location';
    if (message.contactMessage) return 'contact';
    return 'text';
  }

  /**
   * Gerencia QR Code
   */
  handleQRCode(sessionId, qr, sock) {
    const now = Date.now();
    const qrState = this.qrCodeState.get(sessionId) || { count: 0, firstAt: now };

    if (now - qrState.firstAt > 10 * 60 * 1000) {
      qrState.count = 0;
      qrState.firstAt = now;
    }

    qrState.count++;
    this.qrCodeState.set(sessionId, qrState);

    const MAX_QR = 5;
    if (qrState.count > MAX_QR) {
      logger.warn(`⚠️ QR Code loop detectado para ${sessionId}`);

      // Pausa reconexões automáticas: a partir daqui só volta quando o usuário clicar "Conectar"
      this.qrLoopPaused.add(sessionId);

      // Cancela qualquer tentativa agendada
      const timer = this.reconnectTimers.get(sessionId);
      if (timer) {
        clearTimeout(timer);
        this.reconnectTimers.delete(sessionId);
      }

      this.connectionCallbacks.forEach(cb => {
        try {
          cb(sessionId, 'qr-loop', { message: 'Muitas tentativas de QR. Clique em Conectar novamente para gerar um novo QR.' });
        } catch (e) { }
      });

      // Fecha a sessão atual para economizar recursos (mas NÃO limpa auth state)
      try { sock.end?.(new Error('QR Code loop')); } catch (e) { }
      try { sock.ws?.close?.(); } catch (e) { }
      this.sessions.delete(sessionId);
      return;
    }

    logger.info(`📱 QR Code para ${sessionId} (${qrState.count}/${MAX_QR})`);
    logger.info(`📞 Notificando ${this.connectionCallbacks.length} callback(s) de QR Code`);

    this.connectionCallbacks.forEach(cb => {
      try {
        cb(sessionId, 'qr', { qr, attempt: qrState.count, maxAttempts: MAX_QR });
      } catch (e) {
        logger.error(`❌ Erro ao executar callback de QR Code: ${e.message}`);
      }
    });
  }

  /**
   * Gerencia desconexão
   */
  async handleDisconnect(sessionId, lastDisconnect) {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const session = this.sessions.get(sessionId);

    if (session) session.isReady = false;

    const noReconnectCodes = [DisconnectReason.loggedOut, 403, 401];
    // Se pausamos por QR loop, não reconecta automaticamente
    const pausedByQrLoop = this.qrLoopPaused.has(sessionId);
    const shouldReconnect = pausedByQrLoop ? false : !noReconnectCodes.includes(statusCode);

    logger.info(`Conexão fechada para ${sessionId}. StatusCode: ${statusCode}, Reconectar: ${shouldReconnect}`);

    this.connectionCallbacks.forEach(cb => {
      try {
        cb(sessionId, 'close', { shouldReconnect, statusCode });
      } catch (e) { }
    });

    if (shouldReconnect) {
      const prev = this.reconnectState.get(sessionId) || { attempts: 0 };
      prev.attempts++;
      this.reconnectState.set(sessionId, prev);

      if (prev.attempts <= 10) {
        const delay = Math.min(60000, 5000 * Math.pow(1.5, prev.attempts - 1));
        logger.info(`⏳ Reconectando ${sessionId} em ${Math.round(delay / 1000)}s...`);

        const timer = setTimeout(async () => {
          try {
            await this.createSession(sessionId);
          } catch (e) {
            logger.error(`Erro ao reconectar: ${e.message}`);
          }
        }, delay);

        this.reconnectTimers.set(sessionId, timer);
      }
    } else {
      this.sessions.delete(sessionId);
      // Se foi pausa por QR loop, mantém credenciais para o usuário tentar de novo manualmente
      if (!pausedByQrLoop) {
        await clearAuthState(sessionId);
      }
    }
  }

  /**
   * Gerencia conexão estabelecida
   */
  handleConnect(sessionId, sock) {
    logger.info(`✅ Sessão ${sessionId} conectada!`);

    this.qrLoopPaused.delete(sessionId);
    this.reconnectState.delete(sessionId);
    this.qrCodeState.delete(sessionId);

    const timer = this.reconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(sessionId);
    }

    const session = this.sessions.get(sessionId);
    if (session) session.isReady = true;

    const phone = sock.user?.id?.split(':')[0] || '';

    this.connectionCallbacks.forEach(cb => {
      try {
        cb(sessionId, 'open', { phone, user: sock.user });
      } catch (e) {
        logger.error(`Erro em callback de conexão: ${e.message}`);
      }
    });
  }

  /**
   * Obtém sessão específica
   */
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session?.isReady) return null;
    return session.sock;
  }

  /**
   * Lista todas as sessões ativas
   */
  getAllSessions() {
    return Array.from(this.sessions.entries())
      .filter(([_, session]) => session.isReady)
      .map(([id, session]) => ({
        id,
        phone: session.sock.user?.id?.split(':')[0],
        isReady: session.isReady
      }));
  }

  /**
   * Envia uma mensagem de texto
   */
  async sendMessage(sessionId, phone, message) {
    const session = this.sessions.get(sessionId);
    if (!session?.isReady || !session.sock) {
      throw new Error('Sessão não está conectada');
    }

    try {
      // Formata o número para o formato do WhatsApp
      const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;

      logger.info(`📤 Enviando mensagem para ${phone}: "${message.substring(0, 50)}..."`);

      const result = await session.sock.sendMessage(jid, { text: message });

      logger.info(`✅ Mensagem enviada com sucesso para ${phone}`);

      return {
        success: true,
        messageId: result?.key?.id,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error(`❌ Erro ao enviar mensagem: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fecha uma sessão
   */
  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        session.sock?.end?.();
        session.sock?.ws?.close?.();
      } catch (e) { }
      this.sessions.delete(sessionId);
      logger.info(`Sessão ${sessionId} encerrada`);
    }

    const timer = this.reconnectTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(sessionId);
    }
  }

  /**
   * Remove uma sessão completamente
   */
  async removeSession(sessionId) {
    await this.closeSession(sessionId);
    await clearAuthState(sessionId);
    logger.info(`Sessão ${sessionId} removida`);
  }

  /**
   * Restaura sessões a partir do banco
   */
  async restoreSessions(instances = []) {
    const restored = [];

    for (const instance of instances) {
      const sessionId = instance?.sessionId;
      if (!sessionId) continue;

      try {
        logger.info(`🔄 Restaurando sessão ${sessionId}...`);
        await this.createSession(sessionId);
        restored.push(sessionId);

        // Delay entre sessões
        await new Promise(r => setTimeout(r, 3000));
      } catch (error) {
        logger.error(`Erro ao restaurar ${sessionId}: ${error.message}`);
      }
    }

    return restored;
  }
}

export default new SessionManager();
