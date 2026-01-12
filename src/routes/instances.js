import { Router } from 'express';
import { instanceQueries } from '../db/database.js';
import { authenticateToken } from '../middleware/auth.js';
import sessionManager from '../whatsapp/sessionManager.js';
import { logger } from '../config/logger.js';

const router = Router();

router.use(authenticateToken);

/**
 * GET /api/instances
 */
router.get('/', async (req, res) => {
  try {
    const instances = await instanceQueries.findByUserId(req.user.id);

    const instancesWithStatus = instances.map(inst => {
      const session = sessionManager.getSession(inst.session_id);
      return {
        ...inst,
        isConnected: !!session,
        livePhone: session?.user?.id?.split(':')[0] || inst.phone
      };
    });

    res.json({ instances: instancesWithStatus });
  } catch (error) {
    logger.error(`Erro ao listar instâncias: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * POST /api/instances
 */
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Nome é obrigatório' });
    }

    const id = `inst_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const sessionId = `session_${req.user.id}_${Date.now()}`;

    await instanceQueries.create(id, req.user.id, sessionId, name, null, 'disconnected');

    const instance = await instanceQueries.findById(id);

    logger.info(`Nova instância criada: ${name} (${id})`);

    res.status(201).json({
      message: 'Instância criada com sucesso',
      instance
    });
  } catch (error) {
    logger.error(`Erro ao criar instância: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * POST /api/instances/:id/connect
 */
router.post('/:id/connect', async (req, res) => {
  try {
    const { id } = req.params;

    const instance = await instanceQueries.findById(id);
    if (!instance || instance.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Instância não encontrada' });
    }

    await sessionManager.createSession(instance.session_id, { forceNew: false });
    await instanceQueries.updateStatus('connecting', null, id);

    res.json({
      message: 'Conexão iniciada. Aguarde o QR Code.',
      sessionId: instance.session_id
    });
  } catch (error) {
    logger.error(`Erro ao conectar instância: ${error.message}`);
    res.status(500).json({ error: 'Erro ao iniciar conexão' });
  }
});

/**
 * POST /api/instances/:id/disconnect
 */
router.post('/:id/disconnect', async (req, res) => {
  try {
    const { id } = req.params;

    const instance = await instanceQueries.findById(id);
    if (!instance || instance.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Instância não encontrada' });
    }

    await sessionManager.closeSession(instance.session_id);
    await instanceQueries.updateStatus('disconnected', null, id);

    res.json({ message: 'Instância desconectada' });
  } catch (error) {
    logger.error(`Erro ao desconectar instância: ${error.message}`);
    res.status(500).json({ error: 'Erro ao desconectar' });
  }
});

/**
 * DELETE /api/instances/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const instance = await instanceQueries.findById(id);
    if (!instance || instance.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Instância não encontrada' });
    }

    await sessionManager.removeSession(instance.session_id);
    await instanceQueries.delete(id);

    logger.info(`Instância removida: ${instance.name} (${id})`);

    res.json({ message: 'Instância removida com sucesso' });
  } catch (error) {
    logger.error(`Erro ao remover instância: ${error.message}`);
    res.status(500).json({ error: 'Erro ao remover instância' });
  }
});

export default router;
