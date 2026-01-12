import db, { contactQueries, messageQueries, metricsQueries } from '../db/database.js';
import { logger } from '../config/logger.js';

/**
 * Serviço de análise de métricas de atendimento
 * Calcula tempo de resposta, primeira mensagem, tentativas de contato, etc.
 */
class AnalyticsService {

  /**
   * Processa uma nova mensagem recebida/enviada
   */
  processMessage(instanceId, phone, messageData) {
    const { fromMe, body, timestamp, contactName, mediaType, messageId } = messageData;

    try {
      const now = new Date(timestamp);
      const dateStr = now.toISOString().split('T')[0];

      // Busca ou cria contato
      let contact = contactQueries.findByPhone.get(instanceId, phone);
      let isNewContact = false;
      let isReturningContact = false; // Follow receptivo

      // Só usa o contactName se a mensagem veio do contato (não nossa)
      // Isso evita sobrescrever o nome do contato com o nosso nome
      const nameToUse = fromMe ? null : contactName;

      if (!contact) {
        // Novo contato - primeira mensagem
        isNewContact = true;
        contact = contactQueries.upsert.get(
          instanceId,
          phone,
          nameToUse,
          timestamp,
          timestamp
        );
        logger.info(`📥 Novo lead: ${phone} (${nameToUse || 'sem nome'})`);
      } else {
        // Contato existente
        // Verifica se é um "follow receptivo" (contato retornando após um período)
        // Considera "retorno" se a última mensagem foi há mais de 24h e veio do contato (não do cliente)
        if (!fromMe && contact.last_message_at) {
          const lastMsgTime = new Date(contact.last_message_at).getTime();
          const currentMsgTime = new Date(timestamp).getTime();
          const hoursSinceLastMsg = (currentMsgTime - lastMsgTime) / (1000 * 60 * 60);

          // Se passou mais de 24h desde a última mensagem, é um "retorno"
          if (hoursSinceLastMsg >= 24) {
            isReturningContact = true;
            contactQueries.incrementReturnCount.run(contact.id);
            logger.info(`🔄 Follow receptivo: ${phone} retornou após ${Math.round(hoursSinceLastMsg)}h`);
          }
        }

        // Atualiza último contato (só atualiza nome se veio do contato)
        contactQueries.upsert.get(instanceId, phone, nameToUse, null, timestamp);
        contact = contactQueries.findByPhone.get(instanceId, phone);
      }

      // Salva mensagem
      messageQueries.create.run(
        instanceId,
        contact.id,
        messageId || `msg_${Date.now()}`,
        fromMe ? 1 : 0,
        body,
        mediaType,
        timestamp
      );

      // Atualiza contadores
      if (fromMe) {
        contactQueries.incrementSent.run(contact.id);
      } else {
        contactQueries.incrementReceived.run(contact.id);
      }

      // Atualiza métricas diárias (agora inclui returning_contacts)
      metricsQueries.upsertDaily.run(
        instanceId,
        dateStr,
        isNewContact ? 1 : 0,
        fromMe ? 0 : 1,
        fromMe ? 1 : 0,
        isReturningContact ? 1 : 0
      );

      return { contact, isNewContact, isReturningContact };
    } catch (error) {
      logger.error(`Erro ao processar mensagem: ${error.message}`);
      throw error;
    }
  }

  /**
   * Obtém métricas do dashboard para uma instância
   */
  getDashboardMetrics(instanceId, startDate = null, endDate = null) {
    const today = new Date().toISOString().split('T')[0];
    const start = startDate || today;
    const end = endDate || today;

    try {
      // Métricas agregadas do período
      const dailyMetrics = metricsQueries.getByDateRange.all(instanceId, start, end);

      // Totaliza as métricas
      const totals = dailyMetrics.reduce((acc, day) => ({
        newContacts: acc.newContacts + day.new_contacts,
        messagesReceived: acc.messagesReceived + day.total_messages_received,
        messagesSent: acc.messagesSent + day.total_messages_sent,
        returningContacts: acc.returningContacts + (day.returning_contacts || 0)
      }), { newContacts: 0, messagesReceived: 0, messagesSent: 0, returningContacts: 0 });

      // Contatos ativos (com mensagens recentes)
      const activeContacts = this.getActiveContacts(instanceId, 100);

      // Calcula tentativas ativas de contato (enviamos mas não responderam)
      const pendingContacts = this.getPendingContacts(instanceId);

      // Calcula tempos de resposta
      const responseTimes = this.calculateResponseTimes(instanceId, start, end);

      // Contatos por dia
      const contactsByDay = messageQueries.countByDateRange.all(instanceId, start, end);

      return {
        period: { start, end },
        totals,
        pendingContacts: pendingContacts.length,
        activeContacts: activeContacts.length,
        responseTimes,
        contactsByDay,
        dailyBreakdown: dailyMetrics
      };
    } catch (error) {
      logger.error(`Erro ao obter métricas: ${error.message}`);
      throw error;
    }
  }

  /**
   * Obtém contatos ativos ordenados por última mensagem
   */
  getActiveContacts(instanceId, limit = 50) {
    try {
      const contacts = contactQueries.getActiveContacts.all(instanceId, limit);

      return contacts.map(c => ({
        id: c.id,
        phone: c.phone,
        name: c.name,
        firstMessageAt: c.first_message_at,
        lastMessageAt: c.last_message_at,
        messagesSent: c.sent || c.total_messages_sent,
        messagesReceived: c.received || c.total_messages_received,
        isLead: c.is_lead === 1
      }));
    } catch (error) {
      logger.error(`Erro ao obter contatos ativos: ${error.message}`);
      return [];
    }
  }

  /**
   * Obtém contatos pendentes (sem resposta)
   * São contatos onde a última mensagem foi enviada por nós
   */
  getPendingContacts(instanceId) {
    try {
      const query = db.prepare(`
        SELECT c.*, 
               (SELECT m.from_me FROM messages m 
                WHERE m.contact_id = c.id 
                ORDER BY m.timestamp DESC LIMIT 1) as last_from_me
        FROM contacts c
        WHERE c.instance_id = ?
        AND c.total_messages_sent > 0
      `);

      const contacts = query.all(instanceId);
      return contacts.filter(c => c.last_from_me === 1);
    } catch (error) {
      logger.error(`Erro ao obter contatos pendentes: ${error.message}`);
      return [];
    }
  }

  /**
   * Calcula tempos de resposta
   */
  calculateResponseTimes(instanceId, startDate, endDate) {
    try {
      // Busca todas as conversas do período
      const query = db.prepare(`
        SELECT 
          m1.contact_id,
          m1.timestamp as received_at,
          (SELECT MIN(m2.timestamp) 
           FROM messages m2 
           WHERE m2.contact_id = m1.contact_id 
           AND m2.from_me = 1 
           AND m2.timestamp > m1.timestamp) as responded_at
        FROM messages m1
        WHERE m1.instance_id = ?
        AND m1.from_me = 0
        AND DATE(m1.timestamp) >= ?
        AND DATE(m1.timestamp) <= ?
        ORDER BY m1.timestamp ASC
      `);

      const messages = query.all(instanceId, startDate, endDate);

      // Filtra apenas mensagens que foram respondidas
      const responseTimes = messages
        .filter(m => m.responded_at)
        .map(m => {
          const received = new Date(m.received_at).getTime();
          const responded = new Date(m.responded_at).getTime();
          return (responded - received) / 1000; // Em segundos
        });

      if (responseTimes.length === 0) {
        return {
          avgResponseTimeSeconds: 0,
          minResponseTimeSeconds: 0,
          maxResponseTimeSeconds: 0,
          firstResponseTimeSeconds: 0,
          totalResponses: 0
        };
      }

      // Primeira resposta (do primeiro contato de cada cliente)
      const firstResponses = this.getFirstResponseTimes(instanceId, startDate, endDate);
      const avgFirstResponse = firstResponses.length > 0
        ? firstResponses.reduce((a, b) => a + b, 0) / firstResponses.length
        : 0;

      return {
        avgResponseTimeSeconds: Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length),
        minResponseTimeSeconds: Math.round(Math.min(...responseTimes)),
        maxResponseTimeSeconds: Math.round(Math.max(...responseTimes)),
        firstResponseTimeSeconds: Math.round(avgFirstResponse),
        totalResponses: responseTimes.length
      };
    } catch (error) {
      logger.error(`Erro ao calcular tempos de resposta: ${error.message}`);
      return {
        avgResponseTimeSeconds: 0,
        minResponseTimeSeconds: 0,
        maxResponseTimeSeconds: 0,
        firstResponseTimeSeconds: 0,
        totalResponses: 0
      };
    }
  }

  /**
   * Obtém tempos de primeira resposta (leads novos)
   */
  getFirstResponseTimes(instanceId, startDate, endDate) {
    try {
      const query = db.prepare(`
        SELECT 
          c.id as contact_id,
          c.first_message_at,
          (SELECT MIN(m.timestamp) 
           FROM messages m 
           WHERE m.contact_id = c.id 
           AND m.from_me = 1) as first_response_at
        FROM contacts c
        WHERE c.instance_id = ?
        AND DATE(c.first_message_at) >= ?
        AND DATE(c.first_message_at) <= ?
      `);

      const contacts = query.all(instanceId, startDate, endDate);

      return contacts
        .filter(c => c.first_response_at)
        .map(c => {
          const firstMsg = new Date(c.first_message_at).getTime();
          const firstResponse = new Date(c.first_response_at).getTime();
          return (firstResponse - firstMsg) / 1000;
        });
    } catch (error) {
      logger.error(`Erro ao obter tempos de primeira resposta: ${error.message}`);
      return [];
    }
  }

  /**
   * Obtém contatos que são "follows receptivos" (retornaram após período)
   * Esses são contatos valiosos que voltaram a entrar em contato
   */
  getReturningContacts(instanceId, limit = 50) {
    try {
      const query = db.prepare(`
        SELECT c.*,
               (SELECT m.timestamp FROM messages m 
                WHERE m.contact_id = c.id 
                ORDER BY m.timestamp DESC LIMIT 1) as last_message_at_real,
               (SELECT m.body FROM messages m 
                WHERE m.contact_id = c.id 
                ORDER BY m.timestamp DESC LIMIT 1) as last_message
        FROM contacts c
        WHERE c.instance_id = ?
        AND c.return_count > 0
        ORDER BY c.last_message_at DESC
        LIMIT ?
      `);

      const contacts = query.all(instanceId, limit);

      return contacts.map(c => ({
        id: c.id,
        phone: c.phone,
        name: c.name || c.phone,
        firstMessageAt: c.first_message_at,
        lastMessageAt: c.last_message_at,
        returnCount: c.return_count || 0,
        lastMessage: c.last_message,
        messagesReceived: c.total_messages_received,
        messagesSent: c.total_messages_sent
      }));
    } catch (error) {
      logger.error(`Erro ao obter contatos retornando: ${error.message}`);
      return [];
    }
  }

  /**
   * Busca um contato por ID
   */
  getContactById(contactId) {
    try {
      const query = db.prepare(`SELECT * FROM contacts WHERE id = ?`);
      const contact = query.get(contactId);
      if (!contact) return null;

      return {
        id: contact.id,
        instanceId: contact.instance_id,
        phone: contact.phone,
        name: contact.name
      };
    } catch (error) {
      logger.error(`Erro ao buscar contato: ${error.message}`);
      return null;
    }
  }

  /**
   * Obtém conversa completa de um contato
   */
  getConversation(contactId) {
    try {
      const messages = messageQueries.getConversation.all(contactId);
      return messages.map(m => ({
        id: m.id,
        messageId: m.message_id,
        fromMe: m.from_me === 1,
        body: m.body,
        mediaType: m.media_type,
        timestamp: m.timestamp
      }));
    } catch (error) {
      logger.error(`Erro ao obter conversa: ${error.message}`);
      return [];
    }
  }

  /**
   * Obtém contatos com preview da última mensagem
   */
  getContactsWithPreview(instanceId, limit = 50) {
    try {
      const query = db.prepare(`
        SELECT 
          c.*,
          (SELECT m.body FROM messages m 
           WHERE m.contact_id = c.id 
           ORDER BY m.timestamp DESC LIMIT 1) as last_message,
          (SELECT m.from_me FROM messages m 
           WHERE m.contact_id = c.id 
           ORDER BY m.timestamp DESC LIMIT 1) as last_from_me,
          (SELECT COUNT(*) FROM messages m 
           WHERE m.contact_id = c.id AND m.from_me = 0) as unread_count
        FROM contacts c
        WHERE c.instance_id = ?
        ORDER BY c.last_message_at DESC
        LIMIT ?
      `);

      const contacts = query.all(instanceId, limit);

      return contacts.map(c => ({
        id: c.id,
        phone: c.phone,
        name: c.name || c.phone,
        lastMessage: c.last_message,
        lastMessageFromMe: c.last_from_me === 1,
        lastMessageAt: c.last_message_at,
        unreadCount: c.unread_count,
        isLead: c.is_lead === 1,
        returnCount: c.return_count || 0, // Indica se é follow receptivo
        isReturning: (c.return_count || 0) > 0 // Flag para identificar follows
      }));
    } catch (error) {
      logger.error(`Erro ao obter contatos com preview: ${error.message}`);
      return [];
    }
  }

  /**
   * Formata tempo em segundos para texto legível
   */
  formatTime(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
    return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}min`;
  }
}

export default new AnalyticsService();
