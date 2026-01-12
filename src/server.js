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

// Middlewares
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use('/api', limiter);

// Arquivos estáticos
app.use(express.static(path.join(__dirname, '../public')));

// Rotas da API
app.use('/api/auth', authRoutes);
app.use('/api/instances', instancesRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/connect', connectRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Socket.IO
const connectedClients = new Map();
const lastQrBySessionId = new Map();

io.on('connection', (socket) => {
  logger.info(`Cliente conectado: ${socket.id}`);

  socket.on('subscribe', async ({ userId, instanceId }) => {
    if (userId) {
      socket.join(`user:${userId}`);
    }
    if (instanceId) {
      socket.join(`instance:${instanceId}`);
      connectedClients.set(socket.id, { userId, instanceId });

      // Envia QR se disponível
      try {
        const instance = await instanceQueries.findById(instanceId);
        const qr = instance?.session_id ? lastQrBySessionId.get(instance.session_id) : null;
        if (qr) {
          socket.emit('qr-code', { instanceId, qr });
        }
      } catch (e) {
        // ignora
      }
    }
  });

  socket.on('request-qr', async ({ sessionId, instanceId }) => {
    logger.info(`QR Code solicitado via socket: instanceId=${instanceId || '-'}`);
    try {
      let resolvedSessionId = sessionId;
      if (!resolvedSessionId && instanceId) {
        const instance = await instanceQueries.findById(instanceId);
        resolvedSessionId = instance?.session_id || null;
      }

      if (!resolvedSessionId) {
        socket.emit('qr-error', { instanceId, message: 'Instância não encontrada' });
        return;
      }

      const qr = lastQrBySessionId.get(resolvedSessionId);
      if (!qr) {
        socket.emit('qr-error', { instanceId, message: 'QR Code não disponível' });
        return;
      }

      const inst = await instanceQueries.findBySessionId(resolvedSessionId);
      socket.emit('qr-code', { instanceId: inst?.id || instanceId, qr });
    } catch (e) {
      logger.error(`Erro ao processar request-qr: ${e.message}`);
      socket.emit('qr-error', { instanceId, message: 'Erro ao buscar QR Code' });
    }
  });

  socket.on('disconnect', () => {
    connectedClients.delete(socket.id);
    logger.info(`Cliente desconectado: ${socket.id}`);
  });
});

// Callbacks do SessionManager
sessionManager.onConnectionUpdate(async (sessionId, event, data) => {
  logger.info(`Evento de conexão: ${sessionId} - ${event}`);

  const instance = await instanceQueries.findBySessionId(sessionId);
  if (!instance) {
    logger.warn(`Instância não encontrada para sessionId: ${sessionId}`);
    return;
  }

  if (event === 'qr') {
    try {
      const qrBase64 = await QRCode.toDataURL(data.qr, { width: 256 });
      lastQrBySessionId.set(sessionId, qrBase64);

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
    } catch (err) {
      logger.error(`Erro ao gerar QR: ${err.message}`);
    }
  } else if (event === 'open') {
    await instanceQueries.updateStatus('connected', data.phone, instance.id);
    io.to(`instance:${instance.id}`).emit('connected', {
      instanceId: instance.id,
      phone: data.phone
    });
  } else if (event === 'close') {
    const current = await instanceQueries.findById(instance.id);
    if (current?.status === 'connected') {
      await instanceQueries.updateStatus('disconnected', null, instance.id);
      io.to(`instance:${instance.id}`).emit('disconnected', {
        instanceId: instance.id,
        shouldReconnect: data.shouldReconnect
      });
    } else {
      await instanceQueries.updateStatus('disconnected', null, instance.id);
    }
  } else if (event === 'qr-loop') {
    io.to(`instance:${instance.id}`).emit('qr-loop', {
      instanceId: instance.id,
      message: data.message
    });
  }
});

// Callback de mensagens
sessionManager.onMessageReceived(async (sessionId, phone, messageData) => {
  const instance = await instanceQueries.findBySessionId(sessionId);
  if (!instance) {
    return;
  }

  try {
    const result = await analyticsService.processMessage(instance.id, phone, messageData);

    const messageEvent = {
      instanceId: instance.id,
      phone,
      message: messageData,
      isNewContact: result.isNewContact,
      contact: result.contact
    };

    io.to(`instance:${instance.id}`).emit('new-message', messageEvent);
    io.to(`user:${instance.user_id}`).emit('new-message', messageEvent);

    if (result.isNewContact && !messageData.fromMe) {
      io.to(`instance:${instance.id}`).emit('new-lead', {
        instanceId: instance.id,
        phone,
        contactName: messageData.contactName
      });
    }
  } catch (error) {
    logger.error(`Erro ao processar mensagem: ${error.message}`);
  }
});

// Inicialização
async function start() {
  try {
    // Inicializa banco de dados PostgreSQL
    await initializeDatabase();

    server.listen(PORT, () => {
      logger.info(`Servidor rodando em http://localhost:${PORT}`);
      logger.info(`Relatório Oregon - Sistema de Analytics WhatsApp`);
    });
  } catch (error) {
    logger.error(`Erro ao iniciar servidor: ${error.message}`);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('Encerrando servidor...');
  server.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('Encerrando servidor...');
  server.close();
  process.exit(0);
});

start();
