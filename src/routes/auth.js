import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { userQueries } from '../db/database.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';
import { logger } from '../config/logger.js';

const router = Router();

/**
 * POST /api/auth/register
 * Registra um novo usuário (cliente da agência)
 */
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, company } = req.body;
    
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, senha e nome são obrigatórios' });
    }
    
    // Verifica se email já existe
    const existingUser = userQueries.findByEmail.get(email);
    if (existingUser) {
      return res.status(409).json({ error: 'Email já cadastrado' });
    }
    
    // Hash da senha
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // Cria usuário
    const result = userQueries.create.run(email, hashedPassword, name, company || null);
    
    const user = {
      id: result.lastInsertRowid,
      email,
      name,
      company
    };
    
    // Gera token
    const token = generateToken(user);
    
    logger.info(`✅ Novo usuário registrado: ${email}`);
    
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 dias
    });
    
    res.status(201).json({ 
      message: 'Usuário criado com sucesso',
      user,
      token
    });
  } catch (error) {
    logger.error(`Erro no registro: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * POST /api/auth/login
 * Faz login do usuário
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email e senha são obrigatórios' });
    }
    
    // Busca usuário
    const user = userQueries.findByEmail.get(email);
    if (!user) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    
    // Verifica senha
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Credenciais inválidas' });
    }
    
    // Gera token
    const token = generateToken(user);
    
    logger.info(`✅ Login realizado: ${email}`);
    
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000
    });
    
    res.json({ 
      message: 'Login realizado com sucesso',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        company: user.company
      },
      token
    });
  } catch (error) {
    logger.error(`Erro no login: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

/**
 * POST /api/auth/logout
 * Faz logout do usuário
 */
router.post('/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logout realizado com sucesso' });
});

/**
 * GET /api/auth/me
 * Retorna dados do usuário logado
 */
router.get('/me', authenticateToken, (req, res) => {
  try {
    const user = userQueries.findById.get(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Usuário não encontrado' });
    }
    
    res.json({ user });
  } catch (error) {
    logger.error(`Erro ao buscar usuário: ${error.message}`);
    res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

export default router;
