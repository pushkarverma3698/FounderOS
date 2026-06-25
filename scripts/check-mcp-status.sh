#!/bin/bash
# Check MCP server status on local + VPS

set -e

SSH_KEY="$HOME/.ssh/founderos_deploy"
VPS_HOST="root@95.217.162.12"

echo "🔍 MCP Status Checker"
echo "===================="
echo ""

# Local status
echo "📱 LOCAL MACHINE"
echo "────────────────"

if command -v node &> /dev/null; then
    echo "✅ Node.js: $(node --version)"
else
    echo "❌ Node.js not found"
fi

if command -v npx &> /dev/null; then
    echo "✅ NPX available"
else
    echo "❌ NPX not found"
fi

if [ -f ~/.mcp.json ]; then
    echo "✅ ~/.mcp.json exists"
    echo "   Servers: $(jq '.mcpServers | keys | length' ~/.mcp.json)"
    echo "   Servers listed:"
    jq -r '.mcpServers | keys[]' ~/.mcp.json | sed 's/^/     - /'
else
    echo "❌ ~/.mcp.json not found"
fi

if [ -f ~/.claude/settings.json ]; then
    echo "✅ ~/.claude/settings.json exists"
else
    echo "❌ ~/.claude/settings.json not found"
fi

echo ""
echo "📊 Environment Variables"
echo "────────────────────────"
for var in GITHUB_PERSONAL_ACCESS_TOKEN GEMINI_API_KEY COMPOSIO_API_KEY OPENROUTER_API_KEY ANTHROPIC_API_KEY; do
    if [ -n "${!var}" ]; then
        echo "✅ $var is set"
    else
        echo "❌ $var is NOT set"
    fi
done

# VPS status
echo ""
echo "🖥️  PRODUCTION VPS (95.217.162.12)"
echo "────────────────────────────────"

if [ ! -f "$SSH_KEY" ]; then
    echo "❌ SSH key not found at $SSH_KEY"
    exit 1
fi

echo "Checking VPS status..."
echo ""

ssh -i "$SSH_KEY" "$VPS_HOST" << 'SSHCMD'
echo "✅ SSH connection successful"

if [ -f ~/.mcp.json ]; then
    echo "✅ ~/.mcp.json exists on VPS"
    echo "   Servers: $(jq '.mcpServers | keys | length' ~/.mcp.json)"
else
    echo "❌ ~/.mcp.json not found on VPS"
fi

if [ -f ~/.founderos/vps-env.sh ]; then
    echo "✅ ~/.founderos/vps-env.sh exists"
else
    echo "❌ ~/.founderos/vps-env.sh not found"
fi

if [ -f ~/.claude/settings.json ]; then
    echo "✅ ~/.claude/settings.json exists on VPS"
else
    echo "❌ ~/.claude/settings.json not found on VPS"
fi

echo ""
echo "📊 VPS Environment Variables"
if [ -f ~/.founderos/vps-env.sh ]; then
    source ~/.founderos/vps-env.sh
    for var in GITHUB_PERSONAL_ACCESS_TOKEN GEMINI_API_KEY COMPOSIO_API_KEY OPENROUTER_API_KEY ANTHROPIC_API_KEY; do
        if [ -n "${!var}" ]; then
            echo "✅ $var is set"
        else
            echo "❌ $var is NOT set"
        fi
    done
else
    echo "⚠️  vps-env.sh not found - env vars may not be loaded"
fi

echo ""
echo "🔌 Service Status"
if systemctl is-active --quiet founderos; then
    echo "✅ founderos service is RUNNING"
else
    echo "⚠️  founderos service is STOPPED"
fi

echo ""
echo "🔌 Ollama Status"
if curl -s http://localhost:11434/api/tags &>/dev/null; then
    echo "✅ Ollama is RUNNING"
    MODELS=$(curl -s http://localhost:11434/api/tags | jq -r '.models[]?.name' 2>/dev/null | wc -l)
    echo "   Models available: $MODELS"
else
    echo "❌ Ollama is NOT responding"
fi
SSHCMD

echo ""
echo "✅ Status check complete!"
echo ""
echo "💡 Next steps:"
echo "   1. Verify all ✅ indicators are present"
echo "   2. If ❌ appears, refer to VPS-MCP-SETUP.md"
echo "   3. Deploy changes: ./scripts/deploy-mcp-to-vps.sh"
