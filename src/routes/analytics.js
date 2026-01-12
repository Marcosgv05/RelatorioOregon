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
 */
router.get('/dashboard/:instanceId', async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { startDate, endDate } = req.query;

    const instance = await instanceQueries.findById(instanceId);
    if (!instance || instance.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Instância não encontrada' });
    }

    const metrics = await analyticsService.getDashboardMetrics(instanceId, startDate, endDate);

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
 */
router.get('/contacts/:instanceId', async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { limit = 50 } = req.query;

    const instance = await instanceQueries.findById(instanceId);
    if (!instance || instance.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Instância não encontrada' });
    }

    const contacts = await analyticsService.getContactsWithPreview(instanceId, parseInt(limit));
    res.json({ contacts });
  } catch (error) {
    logger.error(`Erro ao obter contatos: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * GET /api/analytics/conversation/:contactId
 */
router.get('/conversation/:contactId', async (req, res) => {
  try {
    const { contactId } = req.params;
    const messages = await analyticsService.getConversation(parseInt(contactId));
    res.json({ messages });
  } catch (error) {
    logger.error(`Erro ao obter conversa: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * GET /api/analytics/pending/:instanceId
 */
router.get('/pending/:instanceId', async (req, res) => {
  try {
    const { instanceId } = req.params;

    const instance = await instanceQueries.findById(instanceId);
    if (!instance || instance.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Instância não encontrada' });
    }

    const pendingContacts = await analyticsService.getPendingContacts(instanceId);
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
 */
router.get('/returning/:instanceId', async (req, res) => {
  try {
    const { instanceId } = req.params;
    const { limit = 50 } = req.query;

    const instance = await instanceQueries.findById(instanceId);
    if (!instance || instance.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Instância não encontrada' });
    }

    const returningContacts = await analyticsService.getReturningContacts(instanceId, parseInt(limit));
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
 */
router.get('/summary', async (req, res) => {
  try {
    const instances = await instanceQueries.findByUserId(req.user.id);

    const summary = await Promise.all(instances.map(async (inst) => {
      const metrics = await analyticsService.getDashboardMetrics(inst.id);
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
    }));

    res.json({ summary });
  } catch (error) {
    logger.error(`Erro ao obter resumo: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * POST /api/analytics/send/:contactId
 */
router.post('/send/:contactId', async (req, res) => {
  try {
    const { contactId } = req.params;
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Mensagem é obrigatória' });
    }

    const contact = await analyticsService.getContactById(parseInt(contactId));
    if (!contact) {
      return res.status(404).json({ error: 'Contato não encontrado' });
    }

    const instance = await instanceQueries.findById(contact.instanceId);
    if (!instance || instance.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Acesso negado' });
    }

    if (instance.status !== 'connected') {
      return res.status(400).json({ error: 'WhatsApp não está conectado' });
    }

    const sessionManager = (await import('../whatsapp/sessionManager.js')).default;
    const result = await sessionManager.sendMessage(instance.session_id, contact.phone, message.trim());

    await analyticsService.processMessage(instance.id, contact.phone, {
      messageId: result.messageId,
      fromMe: true,
      body: message.trim(),
      timestamp: result.timestamp,
      contactName: null,
      mediaType: 'text'
    });

    logger.info(`Mensagem enviada para ${contact.phone} via API`);

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
