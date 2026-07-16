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
# On VPS — fill each value with a REAL secret. This file is never committed and
# is chmod 600 (owner-only). Do NOT leave the placeholders in place: a running
# service with a placeholder key fails loud, which is the point — no silent
# fallback to a fake credential.
cat > /root/.founderos/vps-env.sh << 'EOF'
#!/bin/bash
# FounderOS VPS Environment Variables
# Source this file in ~/.bashrc or Claude startup

export GITHUB_PERSONAL_ACCESS_TOKEN="<real-github-pat>"
export GEMINI_API_KEY="<real-gemini-key>"
export COMPOSIO_API_KEY="<real-composio-key>"
export OPENROUTER_API_KEY="<real-openrouter-key>"
export ANTHROPIC_API_KEY="<real-anthropic-key>"
EOF

chmod 600 /root/.founderos/vps-env.sh
```

> **Secret hygiene:** every value above is a real credential kept only in this
> `chmod 600` file (or the OS keychain), never in the repo, never in a commit,
> never in `mcp-bridge.json`. The FounderOS MCP HTTP server's own token is
> covered in its dedicated section below — generate it, do not hand-pick it.

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

## 🌐 Connect a local MCP client to the VPS server (over SSH)

Everything above configures the MCPs that FounderOS **consumes**. This section
lets you (and colleagues) point a local MCP client — Claude Code, Claude Desktop —
at the read-only knowledge tools FounderOS **exposes** (`search_web`,
`github_read`, `read_context`, `search_memory`, `search_knowledge`, `read_cv`),
running on the VPS against the production data.

**The simple model: launch the stdio server on the VPS over SSH.** Your MCP
client runs `ssh founderos-vps '… node … src/mcp/index.ts'`; JSON-RPC flows over
the SSH pipe. That means:

- **Your SSH key is the auth** — the same key you already use. No bearer token.
- **No open port, no tunnel daemon, no extra service** — the connection lives
  only while your client is running, and drops when it exits.
- **No secrets on your machine** — tool credentials are read from the VPS's own
  `/opt/founderos/.env`; the tools execute on the VPS.

```
Mac (MCP client) ──ssh founderos-vps──▶  VPS: node src/mcp/index.ts (stdio)
   JSON-RPC over the SSH pipe                reads /opt/founderos/.env, runs tools
```

### One-time setup

1. **SSH host alias** — append `deploy/ssh-config.founderos-vps.example` to your
   `~/.ssh/config` (pins the `founderos_deploy` key to `founderos-vps`). Confirm:
   ```bash
   ssh founderos-vps 'echo ok && test -d /opt/founderos && echo found-founderos'
   ```
2. **MCP client config** — copy the `founderos-vps` block from
   `deploy/mcp-founderos-vps.example.json` into your client's config:
   - **Claude Code:** `~/.mcp.json` (global) or a project `.mcp.json`.
   - **Claude Desktop:** `claude_desktop_config.json`.
   ```jsonc
   {
     "mcpServers": {
       "founderos-vps": {
         "command": "ssh",
         "args": ["founderos-vps",
                  "cd /opt/founderos && LOG_STDERR=1 node --env-file=.env --import tsx/esm src/mcp/index.ts"]
       }
     }
   }
   ```
   `LOG_STDERR=1` keeps logs off stdout so the JSON-RPC stream stays clean — it's
   already baked into `pnpm mcp`; keep it in the SSH command too.
3. **Restart the client.** It spawns the SSH child on demand; the VPS tools
   appear as `search_web`, `search_memory`, etc.

### Giving a colleague access

They need exactly two things — nothing FounderOS-specific to install:

1. SSH access to the VPS (their own key added to the VPS `authorized_keys`, or a
   shared deploy key) plus the `founderos-vps` alias from step 1.
2. The `founderos-vps` block from step 2 in their MCP client config.

No token to share, no port to open. Revoke access by removing their SSH key on
the VPS.

### Local Claude Code (same machine as the server)

Running a client on the VPS itself? Just `pnpm mcp` — same tools, stdio, no SSH
hop. (`pnpm mcp` sets `LOG_STDERR=1` for you.)

### If you later need it always-on

The on-demand SSH model above is right for "connect when required." If you ever
want the server **running 24/7** and reachable by multiple clients or non-SSH MCP
clients simultaneously, the always-on HTTP variant (loopback bind + bearer token
+ autossh tunnel + systemd) lived in git history at commit `f54e5a8` — restore it
from there rather than rebuilding.

---

## 📚 Related Docs

- [MCP Official Docs](https://modelcontextprotocol.io/)
- [FounderOS CLAUDE.md](../CLAUDE.md)
- [VPS Production Guide](./PRODUCTION.md)
- [MCP topology spec §1.2](./plans/2026-07-14-MCP-TOPOLOGY-LANGGRAPH-STANDARDS-AGENCY-SCALE.md)
