import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import QRCode from 'qrcode';

import { logger } from './config/logger.js';
import { initializeDatabase, instanceQueries } from './db/database.js';
import sessionManager from './whatsapp/sessionManager.js';
import analyticsService from './services/analyticsService.js';

// Rotas
import authRoutes from './routes/auth.js';
import instancesRoutes from './routes/instances.js';
import analyticsRoutes from './routes/analytics.js';
import connectRoutes from './routes/connect.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 9000;

// Middlewares de segurança
app.use(helmet({
  contentSecurityPolicy: false // Desabilita para permitir inline scripts
}));
app.use(cors({
  origin: true,
  credentials: true
}));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100 // máximo 100 requisições por IP
});
app.use('/api', limiter);

// Arquivos estáticos
app.use(express.static(path.join(__dirname, '../public')));

// Rotas da API
app.use('/api/auth', authRoutes);
app.use('/api/instances', instancesRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/connect', connectRoutes);

// Rota de saúde
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Socket.IO - Conexões em tempo real
const connectedClients = new Map();
// Guarda o último QR por sessão (evita perda de evento quando o frontend abre o modal tarde)
const lastQrBySessionId = new Map(); // sessionId -> dataURL(base64)

io.on('connection', (socket) => {
  logger.info(`🔌 Cliente conectado: ${socket.id}`);
  
  // Cliente se identifica com userId e instanceId
  socket.on('subscribe', ({ userId, instanceId }) => {
    if (userId) {
      socket.join(`user:${userId}`);
      logger.info(`📡 Socket ${socket.id} inscrito na sala user:${userId}`);
    }
    if (instanceId) {
      socket.join(`instance:${instanceId}`);
      connectedClients.set(socket.id, { userId, instanceId });
      logger.info(`📡 Socket ${socket.id} inscrito na instância ${instanceId} (sala: instance:${instanceId})`);
    }

    // Se já existe um QR recente para essa instância, envia imediatamente
    if (instanceId) {
      try {
        const instance = instanceQueries.findById.get(instanceId);
        const qr = instance?.session_id ? lastQrBySessionId.get(instance.session_id) : null;
        if (qr) {
          socket.emit('qr-code', { instanceId, qr });
        }
      } catch (e) {
        // ignora
      }
    }
  });
  
  // Solicita QR Code
  socket.on('request-qr', async ({ sessionId, instanceId }) => {
    logger.info(`📱 QR Code solicitado via socket: sessionId=${sessionId || '-'} instanceId=${instanceId || '-'}`);
    try {
      let resolvedSessionId = sessionId;
      if (!resolvedSessionId && instanceId) {
        const instance = instanceQueries.findById.get(instanceId);
        resolvedSessionId = instance?.session_id || null;
        logger.info(`🔍 SessionId resolvido: ${resolvedSessionId || 'null'} para instância ${instanceId}`);
      }

      if (!resolvedSessionId) {
        logger.warn(`⚠️ Nenhum sessionId encontrado para instância ${instanceId}`);
        socket.emit('qr-error', { instanceId, message: 'Instância não conectada ao WhatsApp' });
        return;
      }

      const qr = lastQrBySessionId.get(resolvedSessionId);
      if (!qr) {
        logger.warn(`⚠️ Nenhum QR Code encontrado para sessionId ${resolvedSessionId}`);
        socket.emit('qr-error', { instanceId, message: 'QR Code não disponível. Conecte a instância ao WhatsApp primeiro.' });
        return;
      }

      // Envia direto para o socket que pediu
      const inst = instanceQueries.findBySessionId.get(resolvedSessionId);
      logger.info(`✅ QR Code encontrado, emitindo para instância ${inst?.id || instanceId}`);
      socket.emit('qr-code', { instanceId: inst?.id || instanceId, qr });
    } catch (e) {
      logger.error(`❌ Erro ao processar request-qr: ${e.message}`);
      socket.emit('qr-error', { instanceId, message: 'Erro ao buscar QR Code' });
    }
  });
  
  socket.on('disconnect', () => {
    connectedClients.delete(socket.id);
    logger.info(`🔌 Cliente desconectado: ${socket.id}`);
  });
});

// Configura callbacks do SessionManager
sessionManager.onConnectionUpdate((sessionId, event, data) => {
  logger.info(`🔔 Evento de conexão: ${sessionId} - ${event}`);
  
  // Encontra a instância pelo sessionId
  const instance = instanceQueries.findBySessionId.get(sessionId);
  if (!instance) {
    logger.warn(`⚠️ Instância não encontrada para sessionId: ${sessionId}`);
    return;
  }
  
  logger.info(`✅ Instância encontrada: ${instance.id} para sessionId: ${sessionId}`);
  
  if (event === 'qr') {
    logger.info(`📱 Gerando QR Code para instância ${instance.id} (user: ${instance.user_id})...`);
    // Gera QR Code como base64
    QRCode.toDataURL(data.qr, { width: 256 })
      .then(qrBase64 => {
        // Guarda o último QR da sessão para permitir request-qr
        lastQrBySessionId.set(sessionId, qrBase64);
        logger.info(`✅ QR Code gerado, emitindo para salas instance:${instance.id} e user:${instance.user_id}`);
        // Emite para ambas as salas para garantir que chegue
        io.to(`instance:${instance.id}`).emit('qr-code', {
          instanceId: instance.id,
          qr: qrBase64,
          attempt: data.attempt,
          maxAttempts: data.maxAttempts
        });
        io.to(`user:${instance.user_id}`).emit('qr-code', {
          instanceId: instance.id,
          qr: qrBase64,
          attempt: data.attempt,
          maxAttempts: data.maxAttempts
        });
        logger.info(`📤 QR Code emitido para Socket.IO salas`);
      })
      .catch(err => logger.error(`❌ Erro ao gerar QR: ${err.message}`));
  } else if (event === 'open') {
    // Atualiza status no banco
    instanceQueries.updateStatus.run('connected', data.phone, instance.id);
    
    io.to(`instance:${instance.id}`).emit('connected', {
      instanceId: instance.id,
      phone: data.phone
    });
  } else if (event === 'close') {
    // Só atualiza status e emite evento se a instância estava realmente conectada antes
    // Isso evita emitir "disconnected" durante a inicialização/restauração
    const currentStatus = instanceQueries.findById.get(instance.id)?.status;
    if (currentStatus === 'connected') {
      instanceQueries.updateStatus.run('disconnected', null, instance.id);
      
      io.to(`instance:${instance.id}`).emit('disconnected', {
        instanceId: instance.id,
        shouldReconnect: data.shouldReconnect
      });
    } else {
      // Se já estava desconectado, só atualiza o status silenciosamente
      instanceQueries.updateStatus.run('disconnected', null, instance.id);
    }
  } else if (event === 'qr-loop') {
    io.to(`instance:${instance.id}`).emit('qr-loop', {
      instanceId: instance.id,
      message: data.message
    });
    io.to(`user:${instance.user_id}`).emit('qr-loop', {
      instanceId: instance.id,
      message: data.message
    });
  }
});

// Callback de mensagens recebidas - processa e envia para analytics
sessionManager.onMessageReceived((sessionId, phone, messageData) => {
  logger.info(`📥 Callback onMessageReceived: sessionId=${sessionId}, phone=${phone}`);
  
  const instance = instanceQueries.findBySessionId.get(sessionId);
  if (!instance) {
    logger.warn(`⚠️ Instância não encontrada para sessionId=${sessionId}`);
    return;
  }
  
  logger.info(`📊 Processando mensagem para instância: ${instance.name} (${instance.id})`);
  
  // Processa mensagem para analytics
  try {
    const result = analyticsService.processMessage(instance.id, phone, messageData);
    
    logger.info(`✅ Mensagem salva: contato=${result.contact?.id}, isNew=${result.isNewContact}`);
    
    // Emite evento de nova mensagem para o frontend (para ambas as salas)
    const messageEvent = {
      instanceId: instance.id,
      phone,
      message: messageData,
      isNewContact: result.isNewContact,
      contact: result.contact
    };
    
    io.to(`instance:${instance.id}`).emit('new-message', messageEvent);
    io.to(`user:${instance.user_id}`).emit('new-message', messageEvent);
    
    logger.info(`📤 Evento new-message emitido para instance:${instance.id} e user:${instance.user_id}`);
    
    // Se for novo contato, emite evento específico
    if (result.isNewContact && !messageData.fromMe) {
      io.to(`instance:${instance.id}`).emit('new-lead', {
        instanceId: instance.id,
        phone,
        contactName: messageData.contactName
      });
      io.to(`user:${instance.user_id}`).emit('new-lead', {
        instanceId: instance.id,
        phone,
        contactName: messageData.contactName
      });
    }
  } catch (error) {
    logger.error(`❌ Erro ao processar mensagem: ${error.message}`);
    logger.error(error.stack);
  }
});

// Inicialização
async function start() {
  try {
    // Inicializa banco de dados
    initializeDatabase();
    
    // Inicia servidor
    server.listen(PORT, () => {
      logger.info(`🚀 Servidor rodando em http://localhost:${PORT}`);
      logger.info(`📊 Relatório Oregon - Sistema de Analytics de WhatsApp`);
    });
    
    // Restauração automática desabilitada para evitar múltiplas requisições ao iniciar
    // As sessões serão restauradas apenas quando o usuário clicar em "Conectar" manualmente
    // Se precisar restaurar automaticamente, descomente o código abaixo:
    /*
    setTimeout(async () => {
      const allInstances = [];
      // Busca todas as instâncias de todos os usuários para restaurar
      try {
        const instances = instanceQueries.findByUserId.all(1); // TODO: Melhorar para pegar de todos
        if (instances && instances.length > 0) {
          logger.info(`🔄 Restaurando ${instances.length} sessão(ões)...`);
          await sessionManager.restoreSessions(instances.map(i => ({ sessionId: i.session_id })));
        }
      } catch (e) {
        // Ignora se não houver sessões
      }
    }, 3000);
    */
    
  } catch (error) {
    logger.error(`❌ Erro ao iniciar servidor: ${error.message}`);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('📴 Encerrando servidor...');
  server.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('📴 Encerrando servidor...');
  server.close();
  process.exit(0);
});

start();
