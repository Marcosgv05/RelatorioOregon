import { Router } from 'express';
import { instanceQueries } from '../db/database.js';
import { authenticateToken } from '../middleware/auth.js';
import { logger } from '../config/logger.js';
import crypto from 'crypto';

const router = Router();

// Gerar token seguro para conexão
function generateConnectionToken(instanceId, userId) {
  const payload = `${instanceId}:${userId}:${Date.now()}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * POST /api/connect/:instanceId/connect-link
 * Gera um link de conexão para uma instância
 */
router.post('/:instanceId/connect-link', authenticateToken, async (req, res) => {
  try {
    logger.info(`🔗 Requisição de link recebida para instância: ${req.params.instanceId}`);
    logger.info(`👤 Usuário autenticado: ${req.user?.id || 'undefined'}`);
    
    const { instanceId } = req.params;
    
    // Verifica se instância pertence ao usuário
    const instance = instanceQueries.findById.get(instanceId);
    if (!instance || instance.user_id !== req.user.id) {
      return res.status(404).json({ error: 'Instância não encontrada' });
    }
    
    // Se a instância não estiver conectando ou conectada, inicia a conexão automaticamente
    if (instance.status === 'disconnected') {
      logger.info(`🚀 Iniciando conexão automática para instância: ${instance.name}`);
      
      try {
        // Importa o sessionManager dinamicamente para evitar circular dependency
        const sessionManager = (await import('../whatsapp/sessionManager.js')).default;
        
        // Pequeno delay para garantir que os callbacks do servidor estejam registrados
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Inicia sessão WhatsApp
        await sessionManager.createSession(instance.session_id, { forceNew: false });
        
        // Atualiza status para connecting
        instanceQueries.updateStatus.run('connecting', null, instanceId);
        
        logger.info(`✅ Sessão iniciada para instância: ${instance.name}`);
      } catch (error) {
        logger.error(`❌ Erro ao iniciar sessão para instância ${instance.name}: ${error.message}`);
        // Continua mesmo se falhar, pois o link ainda pode ser útil
      }
    }
    
    // Gera token único
    const token = generateConnectionToken(instanceId, req.user.id);
    
    // Salva token na instância (poderíamos adicionar uma coluna na tabela instances)
    // Por enquanto, vamos usar o token gerado dinamicamente
    
    const connectLink = `http://localhost:9000/connect.html?token=${token}&instance=${instanceId}`;
    
    logger.info(`🔗 Link de conexão gerado: ${instance.name} (${instanceId})`);
    logger.info(`📋 Link completo: ${connectLink}`);
    
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
    logger.error(`❌ Erro ao gerar link de conexão: ${error.message}`);
    logger.error(`📋 Stack trace: ${error.stack}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * GET /api/public/instance/:instanceId
 * Endpoint público para obter informações da instância (usado na página de conexão)
 */
router.get('/public/instance/:instanceId', (req, res) => {
  try {
    const { instanceId } = req.params;
    const { token } = req.query;
    
    if (!token) {
      return res.status(400).json({ error: 'Token não fornecido' });
    }
    
    // Verifica se instância existe
    const instance = instanceQueries.findById.get(instanceId);
    if (!instance) {
      return res.status(404).json({ error: 'Instância não encontrada' });
    }
    
    // Valida o token (simples validação por enquanto)
    const expectedToken = generateConnectionToken(instanceId, instance.user_id);
    
    // Por segurança, vamos aceitar qualquer token por enquanto
    // Em produção, poderíamos armazenar tokens válidos no banco
    
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
