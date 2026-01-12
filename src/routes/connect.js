import { Router } from 'express';
import { instanceQueries } from '../db/database.js';
import { logger } from '../config/logger.js';
import crypto from 'crypto';

const router = Router();

function generateConnectionToken(instanceId, salt) {
  const payload = `${instanceId}:${salt}:${Date.now()}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * POST /api/connect/:instanceId/connect-link
 */
router.post('/:instanceId/connect-link', async (req, res) => {
  try {
    logger.info(`Requisição de link recebida para instância: ${req.params.instanceId}`);

    const { instanceId } = req.params;

    const instance = await instanceQueries.findById(instanceId);
    if (!instance) {
      return res.status(404).json({ error: 'Instância não encontrada' });
    }

    if (instance.status === 'disconnected') {
      logger.info(`Iniciando conexão automática para instância: ${instance.name}`);

      try {
        const sessionManager = (await import('../whatsapp/sessionManager.js')).default;
        await new Promise(resolve => setTimeout(resolve, 1000));
        await sessionManager.createSession(instance.session_id, { forceNew: false });
        await instanceQueries.updateStatus('connecting', null, instanceId);

        logger.info(`Sessão iniciada para instância: ${instance.name}`);
      } catch (error) {
        logger.error(`Erro ao iniciar sessão para instância ${instance.name}: ${error.message}`);
      }
    }

    const token = generateConnectionToken(instanceId, 'public');

    const protocol = req.protocol;
    const host = req.get('host');
    const connectLink = `${protocol}://${host}/connect.html?token=${token}&instance=${instanceId}`;

    logger.info(`Link de conexão gerado: ${instance.name} (${instanceId})`);

    res.json({
      instance: {
        id: instance.id,
        name: instance.name,
        status: instance.status
      },
      connectLink,
      token,
      instructions: {
        step1: 'Envie este link para o cliente',
        step2: 'Cliente escaneia o QR Code',
        step3: 'Conexão aparece no dashboard'
      }
    });
  } catch (error) {
    logger.error(`Erro ao gerar link de conexão: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * GET /api/public/instance/:instanceId
 */
router.get('/public/instance/:instanceId', async (req, res) => {
  try {
    const { instanceId } = req.params;

    const instance = await instanceQueries.findById(instanceId);
    if (!instance) {
      return res.status(404).json({ error: 'Instância não encontrada' });
    }

    res.json({
      id: instance.id,
      name: instance.name,
      status: instance.status,
      phone: instance.phone
    });
  } catch (error) {
    logger.error(`Erro ao obter instância pública: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

export default router;
