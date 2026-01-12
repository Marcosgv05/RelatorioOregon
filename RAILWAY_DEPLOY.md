# Relatório Oregon - Sistema de Analytics WhatsApp

## Deploy no Railway

### Pré-requisitos
- Conta no Railway
- Git configurado

### Passos para Deploy

1. **Fazer push do código para o GitHub**
   ```bash
   git add .
   git commit -m "Preparando para deploy no Railway"
   git push origin main
   ```

2. **Configurar no Railway**
   - Acesse [railway.app](https://railway.app)
   - Clique em "New Project" → "Deploy from GitHub repo"
   - Selecione seu repositório
   - Railway detectará automaticamente que é um projeto Node.js

3. **Configurar Variáveis de Ambiente**
   No painel do Railway, adicione as seguintes variáveis:
   - `NODE_ENV=production`
   - `PORT=9000`
   - `JWT_SECRET` (gere uma chave secreta aqui)

4. **Ajustes no Código**
   - O projeto já está configurado para usar SQLite local
   - A porta 9000 é configurada automaticamente
   - Health check disponível em `/api/health`

### Funcionalidades
- ✅ Sistema completo de analytics WhatsApp
- ✅ Dashboard em tempo real
- ✅ Autenticação de usuários
- ✅ Socket.IO para atualizações live
- ✅ Banco SQLite (persistência automática)
- ✅ Health check para monitoramento

### URLs Importantes
- **Aplicação**: `https://seu-projeto.railway.app`
- **API**: `https://seu-projeto.railway.app/api`
- **Health Check**: `https://seu-projeto.railway.app/api/health`

### Troubleshooting
- Se ocorrer erro de porta, verifique se a variável `PORT=9000` está configurada
- Para resetar o banco: delete o projeto e crie novamente
- Logs disponíveis no painel do Railway
