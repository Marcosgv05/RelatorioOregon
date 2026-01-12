import jwt from 'jsonwebtoken';
import { logger } from '../config/logger.js';

const JWT_SECRET = process.env.JWT_SECRET || 'oregon-secret-key-change-in-production';

/**
 * Middleware de autenticação - DESABILITADO (acesso público)
 * Sempre define um usuário padrão e passa para o próximo middleware
 */
export function authenticateToken(req, res, next) {
  // Usuário padrão fixo - sem autenticação
  req.user = { id: 1, email: 'usuario@oregon.com', name: 'Usuário' };
  next();
}

/**
 * Gera um token JWT (mantido para compatibilidade)
 */
export function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      name: user.name
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

/**
 * Middleware opcional - não bloqueia se não tiver token
 */
export function optionalAuth(req, res, next) {
  req.user = { id: 1, email: 'usuario@oregon.com', name: 'Usuário' };
  next();
}

export default { authenticateToken, generateToken, optionalAuth };
