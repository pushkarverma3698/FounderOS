#!/bin/bash
# Deploy MCP configuration to production VPS
# Usage: ./scripts/deploy-mcp-to-vps.sh

set -e

VPS_HOST="root@95.217.162.12"
VPS_PORT="22"
SSH_KEY="$HOME/.ssh/founderos_deploy"
VPS_HOME="/root"

echo "🚀 Deploying MCP servers to production VPS..."

# Check SSH key exists
if [ ! -f "$SSH_KEY" ]; then
    echo "❌ SSH key not found at $SSH_KEY"
    exit 1
fi

# Create VPS .mcp.json (adapted for server paths)
cat > /tmp/vps.mcp.json << 'EOF'
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/root/founderos"],
      "description": "FounderOS project filesystem access"
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_PERSONAL_ACCESS_TOKEN"
      },
      "description": "GitHub repository management"
    },
    "ollama": {
      "command": "python3",
      "args": ["/root/ollama-mcp-server/server.py"],
      "env": {
        "OLLAMA_URL": "http://localhost:11434"
      },
      "description": "Local Ollama models"
    },
    "nano-banana": {
      "command": "nano-banana-mcp",
      "env": {
        "GEMINI_API_KEY": "$GEMINI_API_KEY"
      },
      "description": "Image generation via Gemini"
    }
  ]
}
EOF

# Deploy .mcp.json to VPS
echo "📤 Uploading .mcp.json to VPS..."
scp -i "$SSH_KEY" -P "$VPS_PORT" /tmp/vps.mcp.json "$VPS_HOST:$VPS_HOME/.mcp.json"

# Deploy settings.json to VPS
echo "📤 Uploading Claude settings.json to VPS..."
scp -i "$SSH_KEY" -P "$VPS_PORT" ~/.claude/settings.json "$VPS_HOST:$VPS_HOME/.claude/settings.json"

# Create VPS environment file template
cat > /tmp/vps-env-setup.sh << 'EOF'
#!/bin/bash
# VPS MCP Environment Setup
# Source this file: source /root/.founderos/vps-env.sh

export GITHUB_PERSONAL_ACCESS_TOKEN="YOUR_GITHUB_TOKEN_HERE"
export GEMINI_API_KEY="YOUR_GEMINI_KEY_HERE"
export COMPOSIO_API_KEY="YOUR_COMPOSIO_KEY_HERE"
export OPENROUTER_API_KEY="YOUR_OPENROUTER_KEY_HERE"
export ANTHROPIC_API_KEY="YOUR_ANTHROPIC_KEY_HERE"
EOF

echo "📤 Uploading environment setup template to VPS..."
scp -i "$SSH_KEY" -P "$VPS_PORT" /tmp/vps-env-setup.sh "$VPS_HOST:$VPS_HOME/.founderos/vps-env.sh"

# Remote setup commands
echo "⚙️  Configuring VPS..."
ssh -i "$SSH_KEY" -p "$VPS_PORT" "$VPS_HOST" << 'SSHCMD'
set -e
echo "Creating .claude directory..."
mkdir -p /root/.claude

echo "Setting up environment file permissions..."
chmod 600 /root/.founderos/vps-env.sh

echo "Installing global MCP and CLI dependencies..."
npm install -g @modelcontextprotocol/server-filesystem @modelcontextprotocol/server-github opencode-ai 2>/dev/null || true

echo "✅ VPS configuration complete!"
echo ""
echo "NEXT STEPS:"
echo "1. SSH to VPS: ssh -i ~/.ssh/founderos_deploy root@95.217.162.12"
echo "2. Edit environment: nano /root/.founderos/vps-env.sh"
echo "3. Add your API keys to the file"
echo "4. Source the environment: source /root/.founderos/vps-env.sh"
echo "5. Restart Claude service: systemctl restart founderos"
SSHCMD

# Cleanup
rm -f /tmp/vps.mcp.json /tmp/vps-env-setup.sh

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📝 Manual setup required on VPS:"
echo "   1. SSH into VPS and edit: /root/.founderos/vps-env.sh"
echo "   2. Add your API keys"
echo "   3. Source the file or add to Claude startup"
echo "   4. Verify: claude --doctor"
