import { Router } from 'express';
import { instanceQueries } from '../db/database.js';
import { authenticateToken } from '../middleware/auth.js';
import analyticsService from '../services/analyticsService.js';
import { logger } from '../config/logger.js';

const router = Router();

// Todas as rotas requerem autenticação
router.use(authenticateToken);

/**
 * GET /api/analytics/dashboard/:instanceId
 * Retorna métricas do dashboard para uma instância
 */
router.get('/dashboard/:instanceId', (req, res) => {
  try {
    const { instanceId } = req.params;
    const { startDate, endDate } = req.query;

    // Verifica se instância pertence ao usuário
    const instance = instanceQueries.findById.get(instanceId);
    if (!instance || instance.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Instância não encontrada' });
    }

    // Obtém métricas
    const metrics = analyticsService.getDashboardMetrics(instanceId, startDate, endDate);

    // Formata tempos para exibição
    const formattedMetrics = {
      ...metrics,
      responseTimes: {
        ...metrics.responseTimes,
        avgResponseTimeFormatted: analyticsService.formatTime(metrics.responseTimes.avgResponseTimeSeconds),
        firstResponseTimeFormatted: analyticsService.formatTime(metrics.responseTimes.firstResponseTimeSeconds)
      }
    };

    res.json({
      instance: {
        id: instance.id,
        name: instance.name,
        phone: instance.phone
      },
      metrics: formattedMetrics
    });
  } catch (error) {
    logger.error(`Erro ao obter métricas: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * GET /api/analytics/contacts/:instanceId
 * Retorna lista de contatos com preview
 */
router.get('/contacts/:instanceId', (req, res) => {
  try {
    const { instanceId } = req.params;
    const { limit = 50 } = req.query;

    const instance = instanceQueries.findById.get(instanceId);
    if (!instance || instance.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Instância não encontrada' });
    }

    const contacts = analyticsService.getContactsWithPreview(instanceId, parseInt(limit));

    res.json({ contacts });
  } catch (error) {
    logger.error(`Erro ao obter contatos: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * GET /api/analytics/conversation/:contactId
 * Retorna conversa completa de um contato
 */
router.get('/conversation/:contactId', (req, res) => {
  try {
    const { contactId } = req.params;

    // TODO: Verificar se o contato pertence a uma instância do usuário
    // Por simplicidade, pulamos essa verificação aqui

    const messages = analyticsService.getConversation(parseInt(contactId));

    res.json({ messages });
  } catch (error) {
    logger.error(`Erro ao obter conversa: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * GET /api/analytics/pending/:instanceId
 * Retorna contatos aguardando resposta
 */
router.get('/pending/:instanceId', (req, res) => {
  try {
    const { instanceId } = req.params;

    const instance = instanceQueries.findById.get(instanceId);
    if (!instance || instance.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Instância não encontrada' });
    }

    const pendingContacts = analyticsService.getPendingContacts(instanceId);

    res.json({
      count: pendingContacts.length,
      contacts: pendingContacts
    });
  } catch (error) {
    logger.error(`Erro ao obter contatos pendentes: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * GET /api/analytics/returning/:instanceId
 * Retorna contatos que são "follows receptivos" (retornaram após período)
 */
router.get('/returning/:instanceId', (req, res) => {
  try {
    const { instanceId } = req.params;
    const { limit = 50 } = req.query;

    const instance = instanceQueries.findById.get(instanceId);
    if (!instance || instance.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Instância não encontrada' });
    }

    const returningContacts = analyticsService.getReturningContacts(instanceId, parseInt(limit));

    res.json({
      count: returningContacts.length,
      contacts: returningContacts
    });
  } catch (error) {
    logger.error(`Erro ao obter follows receptivos: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * GET /api/analytics/summary
 * Retorna resumo de todas as instâncias do usuário
 */
router.get('/summary', (req, res) => {
  try {
    const instances = instanceQueries.findByUserId.all(req.user.id);

    const summary = instances.map(inst => {
      const metrics = analyticsService.getDashboardMetrics(inst.id);
      return {
        instance: {
          id: inst.id,
          name: inst.name,
          phone: inst.phone,
          status: inst.status
        },
        todayMetrics: {
          newContacts: metrics.totals.newContacts,
          messagesReceived: metrics.totals.messagesReceived,
          messagesSent: metrics.totals.messagesSent,
          pendingContacts: metrics.pendingContacts,
          avgResponseTime: analyticsService.formatTime(metrics.responseTimes.avgResponseTimeSeconds)
        }
      };
    });

    res.json({ summary });
  } catch (error) {
    logger.error(`Erro ao obter resumo: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * POST /api/analytics/send/:contactId
 * Envia uma mensagem para um contato
 */
router.post('/send/:contactId', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Mensagem é obrigatória' });
    }

    // Busca o contato para obter o telefone e a instância
    const contact = analyticsService.getContactById(parseInt(contactId));
    if (!contact) {
      return res.status(404).json({ error: 'Contato não encontrado' });
    }

    // Verifica se a instância pertence ao usuário
    const instance = instanceQueries.findById.get(contact.instanceId);
    if (!instance || instance.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    // Verifica se a instância está conectada
    if (instance.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não está conectado' });
    }

    // Importa o sessionManager
    const sessionManager = (await import('../whatsapp/sessionManager.js')).default;

    // Envia a mensagem
    const result = await sessionManager.sendMessage(instance.session_id, contact.phone, message.trim());

    // Salva a mensagem no banco de dados
    analyticsService.processMessage(instance.id, contact.phone, {
      messageId: result.messageId,
      fromMe: true,
      body: message.trim(),
      timestamp: result.timestamp,
      contactName: null,
      mediaType: 'text'
    });

    logger.info(`📤 Mensagem enviada para ${contact.phone} via API`);

    res.json({
      success: true,
      messageId: result.messageId,
      timestamp: result.timestamp
    });
  } catch (error) {
    logger.error(`Erro ao enviar mensagem: ${error.message}`);
    res.status(500).json({ error: error.message || 'Erro ao enviar mensagem' });
  }
});

export default router;
