import jwt from 'jsonwebtoken';
import { logger } from '../config/logger.js';

const JWT_SECRET = process.env.JWT_SECRET || 'oregon-secret-key-change-in-production';

/**
 * Middleware de autenticação JWT
 */
export function authenticateToken(req, res, next) {
  // Busca token no header Authorization ou no cookie
  const authHeader = req.headers['authorization'];
  const tokenFromHeader = authHeader && authHeader.split(' ')[1];
  const tokenFromCookie = req.cookies?.token;
  
  const token = tokenFromHeader || tokenFromCookie;
  
  if (!token) {
    return res.status(401).json({ error: 'Token de acesso necessário' });
  }
  
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    logger.warn(`Token inválido: ${error.message}`);
    return res.status(403).json({ error: 'Token inválido ou expirado' });
  }
}

/**
 * Gera um token JWT
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
  const authHeader = req.headers['authorization'];
  const tokenFromHeader = authHeader && authHeader.split(' ')[1];
  const tokenFromCookie = req.cookies?.token;
  
  const token = tokenFromHeader || tokenFromCookie;
  
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
    } catch (error) {
      // Ignora erros - apenas não define req.user
    }
  }
  
  next();
}

export default { authenticateToken, generateToken, optionalAuth };
