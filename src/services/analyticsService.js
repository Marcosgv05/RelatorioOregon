import { query, contactQueries, messageQueries, metricsQueries } from '../db/database.js';
import { logger } from '../config/logger.js';

/**
 * Serviço de análise de métricas de atendimento
 * Calcula tempo de resposta, primeira mensagem, tentativas de contato, etc.
 */
class AnalyticsService {

  /**
   * Processa uma nova mensagem recebida/enviada
   */
  async processMessage(instanceId, phone, messageData) {
    const { fromMe, body, timestamp, contactName, mediaType, messageId } = messageData;

    try {
      const now = new Date(timestamp);
      const dateStr = now.toISOString().split('T')[0];

      // Busca ou cria contato
      let contact = await contactQueries.findByPhone(instanceId, phone);
      let isNewContact = false;
      let isReturningContact = false;

      // Só usa o contactName se a mensagem veio do contato
      const nameToUse = fromMe ? null : contactName;

      if (!contact) {
        // Novo contato
        isNewContact = true;
        contact = await contactQueries.upsert(instanceId, phone, nameToUse, timestamp, timestamp);
        logger.info(`Novo lead: ${phone} (${nameToUse || 'sem nome'})`);
      } else {
        // Contato existente - verifica se é retorno
        if (!fromMe && contact.last_message_at) {
          const lastMsgTime = new Date(contact.last_message_at).getTime();
          const currentMsgTime = new Date(timestamp).getTime();
          const hoursSinceLastMsg = (currentMsgTime - lastMsgTime) / (1000 * 60 * 60);

          if (hoursSinceLastMsg >= 24) {
            isReturningContact = true;
            await contactQueries.incrementReturnCount(contact.id);
            logger.info(`Follow receptivo: ${phone} retornou após ${Math.round(hoursSinceLastMsg)}h`);
          }
        }

        // Atualiza contato
        await contactQueries.upsert(instanceId, phone, nameToUse, null, timestamp);
        contact = await contactQueries.findByPhone(instanceId, phone);
      }

      // Salva mensagem
      await messageQueries.create(
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
        await contactQueries.incrementSent(contact.id);
      } else {
        await contactQueries.incrementReceived(contact.id);
      }

      // Atualiza métricas diárias
      await metricsQueries.upsertDaily(
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
   * Obtém métricas do dashboard
   */
  async getDashboardMetrics(instanceId, startDate = null, endDate = null) {
    const today = new Date().toISOString().split('T')[0];
    const start = startDate || today;
    const end = endDate || today;

    try {
      // Métricas agregadas
      const dailyMetrics = await metricsQueries.getByDateRange(instanceId, start, end);

      // Totaliza
      const totals = dailyMetrics.reduce((acc, day) => ({
        newContacts: acc.newContacts + day.new_contacts,
        messagesReceived: acc.messagesReceived + day.total_messages_received,
        messagesSent: acc.messagesSent + day.total_messages_sent,
        returningContacts: acc.returningContacts + (day.returning_contacts || 0)
      }), { newContacts: 0, messagesReceived: 0, messagesSent: 0, returningContacts: 0 });

      // Contatos ativos
      const activeContacts = await this.getActiveContacts(instanceId, 100);

      // Contatos pendentes
      const pendingContacts = await this.getPendingContacts(instanceId);

      // Tempos de resposta
      const responseTimes = await this.calculateResponseTimes(instanceId, start, end);

      // Contatos por dia
      const contactsByDay = await messageQueries.countByDateRange(instanceId, start, end);

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
   * Obtém contatos ativos
   */
  async getActiveContacts(instanceId, limit = 50) {
    try {
      const contacts = await contactQueries.getActiveContacts(instanceId, limit);

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
   */
  async getPendingContacts(instanceId) {
    try {
      const result = await query(`
        SELECT c.*, 
               (SELECT m.from_me FROM messages m 
                WHERE m.contact_id = c.id 
                ORDER BY m.timestamp DESC LIMIT 1) as last_from_me
        FROM contacts c
        WHERE c.instance_id = $1
        AND c.total_messages_sent > 0
      `, [instanceId]);

      return result.rows.filter(c => c.last_from_me === 1);
    } catch (error) {
      logger.error(`Erro ao obter contatos pendentes: ${error.message}`);
      return [];
    }
  }

  /**
   * Calcula tempos de resposta
   */
  async calculateResponseTimes(instanceId, startDate, endDate) {
    try {
      const result = await query(`
        SELECT 
          m1.contact_id,
          m1.timestamp as received_at,
          (SELECT MIN(m2.timestamp) 
           FROM messages m2 
           WHERE m2.contact_id = m1.contact_id 
           AND m2.from_me = 1 
           AND m2.timestamp > m1.timestamp) as responded_at
        FROM messages m1
        WHERE m1.instance_id = $1
        AND m1.from_me = 0
        AND DATE(m1.timestamp) >= $2
        AND DATE(m1.timestamp) <= $3
        ORDER BY m1.timestamp ASC
      `, [instanceId, startDate, endDate]);

      const messages = result.rows;

      const responseTimes = messages
        .filter(m => m.responded_at)
        .map(m => {
          const received = new Date(m.received_at).getTime();
          const responded = new Date(m.responded_at).getTime();
          return (responded - received) / 1000;
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

      const firstResponses = await this.getFirstResponseTimes(instanceId, startDate, endDate);
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
   * Obtém tempos de primeira resposta
   */
  async getFirstResponseTimes(instanceId, startDate, endDate) {
    try {
      const result = await query(`
        SELECT 
          c.id as contact_id,
          c.first_message_at,
          (SELECT MIN(m.timestamp) 
           FROM messages m 
           WHERE m.contact_id = c.id 
           AND m.from_me = 1) as first_response_at
        FROM contacts c
        WHERE c.instance_id = $1
        AND DATE(c.first_message_at) >= $2
        AND DATE(c.first_message_at) <= $3
      `, [instanceId, startDate, endDate]);

      return result.rows
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
   * Obtém follows receptivos
   */
  async getReturningContacts(instanceId, limit = 50) {
    try {
      const result = await query(`
        SELECT c.*,
               (SELECT m.timestamp FROM messages m 
                WHERE m.contact_id = c.id 
                ORDER BY m.timestamp DESC LIMIT 1) as last_message_at_real,
               (SELECT m.body FROM messages m 
                WHERE m.contact_id = c.id 
                ORDER BY m.timestamp DESC LIMIT 1) as last_message
        FROM contacts c
        WHERE c.instance_id = $1
        AND c.return_count > 0
        ORDER BY c.last_message_at DESC
        LIMIT $2
      `, [instanceId, limit]);

      return result.rows.map(c => ({
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
   * Busca contato por ID
   */
  async getContactById(contactId) {
    try {
      const result = await query(`SELECT * FROM contacts WHERE id = $1`, [contactId]);
      const contact = result.rows[0];
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
   * Obtém conversa completa
   */
  async getConversation(contactId) {
    try {
      const messages = await messageQueries.getConversation(contactId);
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
   * Obtém contatos com preview
   */
  async getContactsWithPreview(instanceId, limit = 50) {
    try {
      const result = await query(`
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
        WHERE c.instance_id = $1
        ORDER BY c.last_message_at DESC
        LIMIT $2
      `, [instanceId, limit]);

      return result.rows.map(c => ({
        id: c.id,
        phone: c.phone,
        name: c.name || c.phone,
        lastMessage: c.last_message,
        lastMessageFromMe: c.last_from_me === 1,
        lastMessageAt: c.last_message_at,
        unreadCount: parseInt(c.unread_count) || 0,
        isLead: c.is_lead === 1,
        returnCount: c.return_count || 0,
        isReturning: (c.return_count || 0) > 0
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
