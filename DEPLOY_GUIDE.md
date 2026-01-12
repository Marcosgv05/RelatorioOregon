# Deploy do Relatório Oregon no Railway

## 🚀 Passo a Passo Rápido

### 1. Preparar o Repositório
```bash
# Adicionar todos os arquivos criados
git add .
git commit -m "Configuração para deploy no Railway"
git push origin main
```

### 2. Configurar no Railway
1. Acesse [railway.app](https://railway.app)
2. Login com GitHub
3. "New Project" → "Deploy from GitHub repo"
4. Selecione este repositório
5. Aguarde o deploy automático

### 3. Configurar Variáveis de Ambiente
No painel do Railway → Settings → Variables:
```
NODE_ENV=production
PORT=9000
JWT_SECRET=sua_chave_secreta_aqui (use: openssl rand -base64 32)
```

### 4. Verificar Deploy
- Health Check: `https://seu-app.railway.app/api/health`
- Aplicação: `https://seu-app.railway.app`

## 📋 Arquivos Criados

- `railway.toml` - Configuração do Railway
- `nixpacks.toml` - Configuração do build Node.js 18
- `.env.example` - Exemplo de variáveis de ambiente
- `.dockerignore` - Otimização do Docker
- `RAILWAY_DEPLOY.md` - Documentação completa

## ✅ Características do Deploy

- **Node.js 18** - Versão estável e compatível
- **SQLite** - Banco persistente no Railway
- **Health Check** - Monitoramento automático
- **Zero Config** - Deploy automático detectado
- **Live Updates** - Socket.IO funcionando
- **Production Ready** - Otimizado para produção

## 🔧 Troubleshooting

### Se o app não iniciar:
1. Verifique as variáveis de ambiente
2. Confirme se PORT=9000 está definida
3. Verifique os logs no painel Railway

### Se o banco não persistir:
O Railway mantém o SQLite entre deploys. Não precisa configurar nada.

### Se precisar resetar:
Delete o projeto no Railway e crie novamente.

## 🌐 URLs Após Deploy

- **App Principal**: `https://nome-projeto.railway.app`
- **API Health**: `https://nome-projeto.railway.app/api/health`
- **Dashboard**: `https://nome-projeto.railway.app` (após login)

## 📊 Funcionalidades Disponíveis

✅ Sistema completo de analytics  
✅ Autenticação JWT  
✅ Socket.IO em tempo real  
✅ WhatsApp integration  
✅ Dashboard responsivo  
✅ Banco de dados persistente  
✅ Health check automático  

## 🎯 Próximo Passos

1. Faça o deploy
2. Configure o JWT_SECRET
3. Teste a aplicação
4. Conecte suas instâncias WhatsApp
5. Monitore os analytics em tempo real
