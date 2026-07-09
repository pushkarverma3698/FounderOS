# Production VPS MCP Setup Guide

This guide covers deploying and managing MCP servers on the production VPS for FounderOS.

**VPS Details:**
- Host: `95.217.162.12`
- User: `root`
- SSH Key: `~/.ssh/founderos_deploy`
- Home Dir: `/root`
- Project: `/root/founderos`

---

## 🚀 Quick Deploy (Local)

From your Mac:

```bash
cd ~/Projects/founderos
./scripts/deploy-mcp-to-vps.sh
```

This will:
1. Upload `.mcp.json` to VPS
2. Upload `settings.json` to VPS
3. Create environment setup template
4. Install npm MCP packages
5. Set proper permissions

---

## 📋 Manual VPS Setup

### Step 1: SSH into VPS

```bash
ssh -i ~/.ssh/founderos_deploy root@95.217.162.12
```

### Step 2: Create MCP Directory Structure

```bash
mkdir -p /root/.claude
mkdir -p /root/.founderos
cd /root
```

### Step 3: Copy Global .mcp.json

From your Mac, copy the global config:

```bash
scp -i ~/.ssh/founderos_deploy ~/.mcp.json root@95.217.162.12:~/.mcp.json
```

Or create directly on VPS:

```bash
# On VPS:
cat > /root/.mcp.json << 'EOF'
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/root/founderos"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_PERSONAL_ACCESS_TOKEN"}
    },
    "ollama": {
      "command": "python3",
      "args": ["/root/ollama-mcp-server/server.py"],
      "env": {"OLLAMA_URL": "http://localhost:11434"}
    },
    "nano-banana": {
      "command": "nano-banana-mcp",
      "env": {"GEMINI_API_KEY": "$GEMINI_API_KEY"}
    }
  }
}
EOF
```

### Step 4: Setup Environment Variables

Create environment file:

```bash
# On VPS:
cat > /root/.founderos/vps-env.sh << 'EOF'
#!/bin/bash
# FounderOS VPS Environment Variables
# Source this file in ~/.bashrc or Claude startup

export GITHUB_PERSONAL_ACCESS_TOKEN="ghp_your_token_here"
export GEMINI_API_KEY="your_gemini_key_here"
export COMPOSIO_API_KEY="your_composio_key_here"
export OPENROUTER_API_KEY="your_openrouter_key_here"
export ANTHROPIC_API_KEY="your_anthropic_key_here"
EOF

chmod 600 /root/.founderos/vps-env.sh
```

### Step 5: Load Environment at Startup

Add to `/root/.bashrc`:

```bash
# Load FounderOS environment
if [ -f "$HOME/.founderos/vps-env.sh" ]; then
    source "$HOME/.founderos/vps-env.sh"
fi
```

Reload shell:
```bash
source /root/.bashrc
```

### Step 6: Verify MCP Installation

```bash
# Test filesystem MCP
npx -y @modelcontextprotocol/server-filesystem /root/founderos --list

# Test GitHub MCP (with token set)
npx -y @modelcontextprotocol/server-github --help

# Test Ollama connection
curl -s http://localhost:11434/api/tags | jq .
```

### Step 7: Update Claude Settings on VPS

Copy Claude settings:

```bash
# From local Mac:
scp -i ~/.ssh/founderos_deploy ~/.claude/settings.json root@95.217.162.12:/root/.claude/settings.json

# Or create on VPS with VPS-specific paths:
mkdir -p /root/.claude
cat > /root/.claude/settings.json << 'EOF'
{
  "permissions": {
    "allow": [
      "mcp__filesystem__*",
      "mcp__github__*"
    ]
  },
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/root/founderos"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_PERSONAL_ACCESS_TOKEN"}
    }
  },
  "alwaysThinkingEnabled": true
}
EOF
```

### Step 8: Restart Claude Service

```bash
sudo systemctl restart founderos
sudo systemctl status founderos
```

Verify:
```bash
sudo journalctl -u founderos -f -n 50
```

---

## 🔐 Environment Variable Security

### Never commit .founderos/vps-env.sh to git

```bash
# Add to .gitignore:
echo ".founderos/vps-env.sh" >> /root/founderos/.gitignore
```

### Rotate keys periodically

```bash
# On VPS, edit and update keys:
nano /root/.founderos/vps-env.sh

# Reload:
source /root/.founderos/vps-env.sh

# Restart Claude:
sudo systemctl restart founderos
```

---

## 📊 Verify MCP Status

```bash
# Check MCP server registration
claude --doctor

# Test each MCP
curl http://localhost:11434/api/tags  # Ollama
gh api user  # GitHub (requires GITHUB_TOKEN)

# Check logs
sudo journalctl -u founderos -f
```

---

## 🆘 Troubleshooting

### MCP not loading

```bash
# Check environment variables are set
env | grep -E "(GITHUB|GEMINI|COMPOSIO|OPENROUTER|ANTHROPIC)"

# Verify .mcp.json syntax
jq . ~/.mcp.json

# Check permissions
ls -la ~/.mcp.json
ls -la ~/.claude/settings.json
```

### Connection refused

```bash
# Ensure Ollama is running
sudo systemctl status ollama

# Check port 11434
netstat -tuln | grep 11434
curl http://localhost:11434/api/tags
```

### Permission denied on GitHub

```bash
# Verify token has correct scopes
# https://github.com/settings/tokens
# Required: repo, read:user, read:org

# Test token
gh auth status
gh api user
```

---

## 📝 Deployment Checklist

- [ ] SSH key verified: `ls ~/.ssh/founderos_deploy`
- [ ] Run deploy script: `./scripts/deploy-mcp-to-vps.sh`
- [ ] SSH into VPS and verify files uploaded
- [ ] Edit `/root/.founderos/vps-env.sh` with real API keys
- [ ] Source environment: `source ~/.bashrc`
- [ ] Test MCPs: `claude --doctor`
- [ ] Restart service: `sudo systemctl restart founderos`
- [ ] Check logs: `sudo journalctl -u founderos -f`
- [ ] Add `.founderos/vps-env.sh` to `.gitignore`

---

## 📚 Related Docs

- [MCP Official Docs](https://modelcontextprotocol.io/)
- [FounderOS CLAUDE.md](../CLAUDE.md)
- [VPS Production Guide](./PRODUCTION.md)
