#!/bin/bash

echo "🚀 Preparando Relatório Oregon para deploy no Railway..."

# Verificar se está no git
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "❌ Este não é um repositório Git. Inicialize com: git init"
    exit 1
fi

# Adicionar todos os arquivos
echo "📦 Adicionando arquivos..."
git add .

# Commit
echo "💾 Fazendo commit..."
git commit -m "🚀 Ready for Railway deploy - $(date)"

# Verificar se tem remote configurado
if ! git remote get-url origin > /dev/null 2>&1; then
    echo "⚠️  Nenhum remote 'origin' configurado."
    echo "Configure com: git remote add origin <seu-repo-github>"
    echo "Depois execute: git push -u origin main"
    exit 1
fi

# Push
echo "📤 Enviando para GitHub..."
git push origin main

echo ""
echo "✅ Projeto enviado para GitHub!"
echo ""
echo "🌐 Próximos passos:"
echo "1. Acesse https://railway.app"
echo "2. Clique em 'New Project' → 'Deploy from GitHub repo'"
echo "3. Selecione este repositório"
echo "4. Configure as variáveis de ambiente:"
echo "   - NODE_ENV=production"
echo "   - PORT=9000"
echo "   - JWT_SECRET=$(openssl rand -base64 32)"
echo ""
echo "🎉 Seu app estará disponível em: https://seu-projeto.railway.app"
