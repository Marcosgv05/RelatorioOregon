# 📊 Relatório Oregon

Sistema de análise de atendimento WhatsApp para agências de marketing. Conecte o WhatsApp dos seus clientes e monitore métricas de atendimento em tempo real.

## ✨ Funcionalidades

### 📱 Conexão WhatsApp
- Conecte múltiplos celulares via QR Code
- Sistema multi-tenant (cada cliente tem seus dados isolados)
- Reconexão automática

### 📈 Dashboard de Métricas
- **Novos Leads**: Identifica novas conversas iniciadas
- **Tempo de Primeira Resposta**: Quanto tempo o cliente leva para responder um novo lead
- **Tempo Médio de Resposta**: Média de tempo para responder mensagens
- **Tentativas Ativas de Contato**: Quantos contatos estão sem resposta
- **Contatos por Período**: Análise de volume por dia

### 💬 Visualizador de Conversas
- Lista de contatos estilo WhatsApp Web
- Preview da última mensagem
- Histórico completo de cada conversa
- Busca de contatos

### 🔔 Notificações em Tempo Real
- Novos leads aparecem instantaneamente
- Atualizações de métricas em tempo real via Socket.IO

## 🚀 Instalação

### Pré-requisitos
- Node.js 18 ou superior
- NPM ou Yarn

### Passos

1. **Entre na pasta do projeto**
```bash
cd RelatorioOregon
```

2. **Instale as dependências**
```bash
npm install
```

3. **Inicie o servidor**
```bash
npm start
```

4. **Acesse a aplicação**
Abra http://localhost:9000 no seu navegador

## 🌐 Deploy na Nuvem (Railway)

### Deploy Automático
O projeto está configurado para deploy automático no Railway:

1. **Fazer push para GitHub**
```bash
git add .
git commit -m "Ready for Railway deploy"
git push origin main
```

2. **Configurar no Railway**
- Acesse [railway.app](https://railway.app)
- "New Project" → "Deploy from GitHub repo"
- Selecione este repositório
- Configure as variáveis de ambiente:
  - `NODE_ENV=production`
  - `PORT=9000`
  - `JWT_SECRET` (gere uma chave secreta)

3. **Pronto!** 🎉
A aplicação estará disponível em `https://seu-projeto.railway.app`

### Documentação Completa
- [DEPLOY_GUIDE.md](./DEPLOY_GUIDE.md) - Guia detalhado de deploy
- [RAILWAY_DEPLOY.md](./RAILWAY_DEPLOY.md) - Configurações específicas

4. **Acesse no navegador**
```
http://localhost:9000
```

## 📖 Como Usar

### 1. Primeiro Acesso
1. Acesse `http://localhost:9000`
2. Clique em "Cadastrar"
3. Preencha seus dados (nome, email, senha)
4. Clique em "Cadastrar"

### 2. Conectar WhatsApp
1. Vá na aba "Conexões"
2. Clique em "+ Nova Conexão"
3. Dê um nome (ex: "Cliente João - Principal")
4. Clique em "Conectar"
5. Escaneie o QR Code com o WhatsApp do celular

### 3. Ver Métricas
1. Vá na aba "Dashboard"
2. Selecione a conexão no dropdown
3. Use os filtros de data para ver períodos específicos
4. As métricas são atualizadas em tempo real

### 4. Ver Conversas
1. Vá na aba "Conversas"
2. Clique em um contato para ver o histórico
3. Use a busca para encontrar contatos

## 📊 Métricas Explicadas

| Métrica | Descrição |
|---------|-----------|
| **Novos Leads** | Número de novas pessoas que entraram em contato pela primeira vez |
| **Tempo de Primeira Resposta** | Quanto tempo em média o cliente (seu cliente da agência) leva para responder a primeira mensagem de um lead |
| **Tempo Médio de Resposta** | Média de tempo entre receber uma mensagem e responder |
| **Aguardando Resposta** | Quantos contatos receberam uma mensagem mas ainda não responderam |
| **Mensagens Recebidas** | Total de mensagens que o cliente recebeu |
| **Mensagens Enviadas** | Total de mensagens que o cliente enviou |

## 🛠️ Tecnologias

- **Backend**: Node.js, Express
- **Frontend**: HTML, CSS, JavaScript (Vanilla)
- **Banco de Dados**: SQLite (sem necessidade de servidor externo)
- **WhatsApp**: Baileys API
- **Real-time**: Socket.IO
- **Autenticação**: JWT
- **Gráficos**: Chart.js

## 📁 Estrutura do Projeto

```
RelatorioOregon/
├── src/
│   ├── config/
│   │   └── logger.js          # Configuração de logs
│   ├── db/
│   │   └── database.js        # Banco SQLite
│   ├── middleware/
│   │   └── auth.js            # Autenticação JWT
│   ├── routes/
│   │   ├── auth.js            # Login/Registro
│   │   ├── instances.js       # Gerenciamento de conexões
│   │   └── analytics.js       # Métricas e dados
│   ├── services/
│   │   └── analyticsService.js # Cálculo de métricas
│   ├── whatsapp/
│   │   ├── sessionManager.js  # Gerenciador de sessões
│   │   └── authStateDB.js     # Estado de autenticação
│   └── server.js              # Servidor principal
├── public/
│   ├── index.html             # Página principal
│   ├── styles.css             # Estilos
│   └── app.js                 # JavaScript do frontend
├── auth_sessions/             # Dados de autenticação WhatsApp
├── oregon.db                  # Banco de dados (gerado automaticamente)
├── package.json
└── README.md
```

## 🔐 Segurança

- Senhas são hasheadas com bcrypt
- Autenticação via JWT com cookies httpOnly
- Dados isolados por usuário (multi-tenant)
- Rate limiting na API

## ⚠️ Avisos Importantes

1. **WhatsApp**: Este sistema usa a API não-oficial do WhatsApp (Baileys). Use com responsabilidade.
2. **Celular conectado**: O celular precisa estar online e com internet para as mensagens serem capturadas.
3. **Backup**: O banco de dados é salvo em `oregon.db`. Faça backup regularmente.

## 📞 Suporte

Para dúvidas ou problemas, abra uma issue no repositório.

---

**Desenvolvido para agências de marketing que precisam monitorar a qualidade de atendimento de seus clientes** 🚀
