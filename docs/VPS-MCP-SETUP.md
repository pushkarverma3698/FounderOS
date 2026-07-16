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

## 🌐 FounderOS MCP HTTP server (Mac ⇄ VPS bridge)

Everything above configures the MCPs that FounderOS **consumes**. This section
sets up the MCP server FounderOS **exposes** — its own read-only knowledge tools
(`search_web`, `github_read`, `read_context`, `search_memory`, `search_knowledge`,
`read_cv`) served over Streamable HTTP from the VPS so the Mac's MCP clients
(Claude Code / Desktop / the FounderOS bridge) can query the production data
plane. Spec: `docs/plans/2026-07-14-MCP-TOPOLOGY-...md` §1.2.

**Topology (defense-in-depth on a private transport):**

```
Mac  ──(ssh -N -L 3100:127.0.0.1:3100)──▶  VPS 127.0.0.1:3100
 MCP client → http://127.0.0.1:3100/mcp        founderos-mcp.service
 Authorization: Bearer <token>                  bind 127.0.0.1 only · token
                                                checked BEFORE tool dispatch
```

The port never leaves the VPS's loopback — the SSH tunnel is the only ingress —
and even inside the tunnel every request must carry the bearer token.

### VPS side

**1. Generate the token** (do NOT hand-pick one) and store it in the app `.env`
(chmod 600, never committed):

```bash
# On the VPS:
TOKEN="$(openssl rand -hex 32)"
printf 'FOUNDEROS_MCP_TOKEN=%s\n' "$TOKEN" >> /opt/founderos/.env
# optional overrides (defaults shown):
#   FOUNDEROS_MCP_PORT=3100
#   FOUNDEROS_MCP_HOST=127.0.0.1
chmod 600 /opt/founderos/.env
echo "Mac needs this exact value → Bearer $TOKEN"   # copy for the Mac step
```

The server refuses to start if `FOUNDEROS_MCP_TOKEN` is unset or shorter than 16
chars, and refuses any non-loopback bind unless `FOUNDEROS_MCP_ALLOW_PUBLIC=1`.

**2. Install the systemd unit** (`deploy/founderos-mcp.service`, modeled on the
production `founderos.service` — `User=founderos`, `WorkingDirectory=/opt/founderos`):

```bash
sudo cp /opt/founderos/deploy/founderos-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now founderos-mcp
systemctl status founderos-mcp
# liveness (no auth needed — returns no data):
curl -s http://127.0.0.1:3100/healthz    # → {"status":"ok"}
# auth boundary (should be 401 without a token):
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3100/mcp   # → 401
```

### Mac side

**3. SSH host alias** — append `deploy/ssh-config.founderos-vps.example` to
`~/.ssh/config` (pins `founderos_deploy` to this host).

**4. autossh tunnel via launchd** — `deploy/com.founderos.mcp-tunnel.plist`
(replace `YOUR_USERNAME`, confirm the `autossh` path with `which autossh`):

```bash
brew install autossh    # if not present
cp deploy/com.founderos.mcp-tunnel.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.founderos.mcp-tunnel.plist
curl -s http://127.0.0.1:3100/healthz    # now answered THROUGH the tunnel
```

**5. Bridge manifest** — copy the `founderos-vps` block from
`mcp-bridge.example.json` into `mcp-bridge.json`, then set the Mac env var the
manifest references. ⚠️ **`headerEnv` sends the value verbatim as the header**, so
this var holds the full `Bearer <token>` string — not the raw token:

```bash
export FOUNDEROS_MCP_BEARER="Bearer <the-token-from-step-1>"   # keep in keychain/env, not the repo
# then, in .env or the shell that launches FounderOS:
#   MCP_BRIDGE_ENABLED=true
pnpm mcp:probe mcp-bridge.json --invoke     # verify the server connects + lists tools
```

The token value lives only on the two machines (VPS `.env`, Mac keychain/env);
`mcp-bridge.json` and this repo only ever name the env var, never its value.

### Local Claude Code (no network)

`pnpm mcp` still serves the same tools over **stdio** for a Claude Code instance
running on the same box — no token, no port. HTTP is only for the cross-machine hop.

---

## 📚 Related Docs

- [MCP Official Docs](https://modelcontextprotocol.io/)
- [FounderOS CLAUDE.md](../CLAUDE.md)
- [VPS Production Guide](./PRODUCTION.md)
- [MCP topology spec §1.2](./plans/2026-07-14-MCP-TOPOLOGY-LANGGRAPH-STANDARDS-AGENCY-SCALE.md)
