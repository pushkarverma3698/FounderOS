# MCP Global & VPS Deployment Summary

**Date:** 2026-06-23  
**Status:** ✅ Ready for deployment  
**Scope:** Global (Mac) + Production VPS

---

## 📦 What Was Set Up

### 1. Global Installation (Your Mac)

**File:** `~/.mcp.json`

Contains all 10 MCP servers configured globally for ALL Claude tools:

| Server | Purpose | Type |
|--------|---------|------|
| **filesystem** | Safe read/write to ~/Projects/founderos | Official MCP |
| **github** | Repository management, PRs, issues | Official MCP |
| **ollama** | Local model inference (qwen2.5, embeddings) | Custom |
| **nano-banana** | Image generation via Gemini | Custom |
| **composio-personal** | Instagram, LinkedIn (personal account) | Custom |
| **composio-turicks** | LinkedIn (Turicks internal) | Custom |
| **composio-turicks-work** | Gmail, Drive (Turicks work) | Custom |
| **composio-default** | Gmail, Drive (default account) | Custom |
| **composio-personal-google** | Gmail (personal Google) | Custom |
| **safari** | Browser automation (macOS only) | Custom |

### 2. Global Settings

**File:** `~/.claude/settings.json` (updated)

- ✅ Hardcoded API keys removed
- ✅ Environment variable references added
- ✅ Filesystem MCP permissions granted
- ✅ Extended thinking enabled
- ✅ Apify Agent Skills auto-loaded

### 3. Production VPS Setup

**Script:** `scripts/deploy-mcp-to-vps.sh`

Automates:
1. Upload `.mcp.json` to VPS
2. Upload `settings.json` to VPS
3. Create environment file template
4. Install npm MCP packages
5. Set correct file permissions

**Manual Guide:** `docs/VPS-MCP-SETUP.md`

Step-by-step instructions for:
- SSH setup
- MCP configuration
- Environment variable management
- Verification & troubleshooting

### 4. Monitoring Tools

**Script:** `scripts/check-mcp-status.sh`

Checks status of:
- Local MCP configuration
- Environment variables (local & VPS)
- VPS connectivity
- Ollama health
- Claude service status

---

## 🚀 Deployment Steps

### Phase 1: Local Setup (DONE ✅)

```bash
# Files already created:
ls -la ~/.mcp.json                          # Global MCP config
ls -la ~/.claude/settings.json              # Global Claude settings
ls -la ~/Projects/founderos/scripts/deploy-*.sh  # Deploy scripts
```

### Phase 2: Verify Local Setup

```bash
cd ~/Projects/founderos

# Check all configurations
./scripts/check-mcp-status.sh

# Expected output:
# ✅ Node.js: v22.x
# ✅ NPX available
# ✅ ~/.mcp.json exists (10 servers)
# ✅ Environment variables set (or marked as not set)
# ✅ SSH connection successful
# ✅ Ollama is RUNNING
```

### Phase 3: Deploy to VPS

```bash
# Run the deployment script
cd ~/Projects/founderos
./scripts/deploy-mcp-to-vps.sh

# This will:
# 1. Upload configs via SCP
# 2. Remote: mkdir -p /root/.claude
# 3. Remote: Install npm packages
# 4. Create /root/.founderos/vps-env.sh template
```

### Phase 4: Configure VPS Environment

```bash
# SSH into VPS
ssh -i ~/.ssh/founderos_deploy root@95.217.162.12

# Edit environment file (created by deploy script)
nano /root/.founderos/vps-env.sh

# Add your API keys:
export GITHUB_PERSONAL_ACCESS_TOKEN="ghp_..."
export GEMINI_API_KEY="AQ..."
export COMPOSIO_API_KEY="ak_..."
export OPENROUTER_API_KEY="sk-or-..."
export ANTHROPIC_API_KEY="sk-ant-..."

# Save and exit (Ctrl+O, Enter, Ctrl+X)

# Load environment
source /root/.founderos/vps-env.sh

# Verify keys are loaded
env | grep GITHUB_PERSONAL_ACCESS_TOKEN
```

### Phase 5: Verify VPS Setup

```bash
# Still on VPS, run:
./scripts/check-mcp-status.sh

# Or manually:
curl http://localhost:11434/api/tags  # Test Ollama
gh api user  # Test GitHub (with token)
```

### Phase 6: Restart Claude Service

```bash
# On VPS:
sudo systemctl restart founderos
sudo systemctl status founderos

# Check logs:
sudo journalctl -u founderos -f -n 50
```

---

## 📋 File Locations

### Local (Mac)

```
~/.mcp.json                                    # ✅ Global MCP config
~/.claude/settings.json                        # ✅ Global Claude settings
~/.claude/composio-mcp-entity.mjs              # ✅ Existing Composio setup
~/.ssh/founderos_deploy                        # ✅ VPS deploy key
~/Projects/founderos/scripts/
  ├── deploy-mcp-to-vps.sh                    # ✅ Main deployment script
  └── check-mcp-status.sh                      # ✅ Status monitoring
~/Projects/founderos/docs/
  ├── VPS-MCP-SETUP.md                        # ✅ Manual VPS setup guide
  └── MCP-DEPLOYMENT-SUMMARY.md               # ✅ This file
```

### Production VPS

```
/root/.mcp.json                                # Uploaded by deploy script
/root/.claude/settings.json                    # Uploaded by deploy script
/root/.founderos/vps-env.sh                    # Created by deploy script
/root/founderos                                # Project root (read/write)
/root/ollama-mcp-server/                       # Ollama MCP server
```

---

## 🔐 Security Checklist

- [ ] **Local API Keys**: All hardcoded keys removed from `.mcp.json` and `settings.json`
- [ ] **Environment Variables**: All keys now use `$VAR_NAME` references
- [ ] **VPS Environment File**: Created at `/root/.founderos/vps-env.sh` with 600 permissions
- [ ] **Git Safety**: `.founderos/vps-env.sh` will be in `.gitignore`
- [ ] **Key Rotation**: Original exposed keys have been rotated
- [ ] **SSH Key Security**: Deploy key has correct permissions (600)

**Still TODO:**
- [ ] Rotate your 3 exposed API keys (COMPOSIO, GITHUB, GEMINI)
- [ ] Update `/root/.founderos/vps-env.sh` with new keys
- [ ] Verify no hardcoded keys in any config files

---

## 📊 Environment Variables (All Locations)

### On Your Mac

These must be exported in your shell for local Claude to access MCPs:

```bash
# Add to ~/.zshrc
export GITHUB_PERSONAL_ACCESS_TOKEN="ghp_..."
export GEMINI_API_KEY="AQ..."
export COMPOSIO_API_KEY="ak_..."
export OPENROUTER_API_KEY="sk-or-..."
export ANTHROPIC_API_KEY="sk-ant-..."

# Reload
source ~/.zshrc
```

### On VPS

These are sourced from `/root/.founderos/vps-env.sh`:

```bash
# On VPS:
source /root/.founderos/vps-env.sh

# Verify
env | grep -E "(GITHUB|GEMINI|COMPOSIO|OPENROUTER|ANTHROPIC)"
```

### In CI/CD (if applicable)

Add to GitHub secrets or deploy pipeline:
- `GITHUB_PERSONAL_ACCESS_TOKEN`
- `GEMINI_API_KEY`
- `COMPOSIO_API_KEY`
- `OPENROUTER_API_KEY`
- `ANTHROPIC_API_KEY`

---

## ✅ Verification Commands

### Quick Verification

```bash
# On your Mac:
./scripts/check-mcp-status.sh

# On VPS:
ssh -i ~/.ssh/founderos_deploy root@95.217.162.12 ./scripts/check-mcp-status.sh
```

### Detailed Verification

```bash
# Local:
jq . ~/.mcp.json                              # Syntax check
jq '.mcpServers | keys' ~/.mcp.json           # List servers
claude --doctor                               # Claude diagnostics

# VPS:
ssh -i ~/.ssh/founderos_deploy root@95.217.162.12 << 'EOF'
curl http://localhost:11434/api/tags          # Ollama
jq . ~/.mcp.json                              # Config
env | grep GITHUB_PERSONAL_ACCESS_TOKEN       # Env vars
sudo systemctl status founderos               # Service
EOF
```

---

## 🆘 Troubleshooting Reference

### Problem: MCPs Not Loading

```bash
# Check environment variables
echo $GITHUB_PERSONAL_ACCESS_TOKEN
echo $GEMINI_API_KEY

# Validate .mcp.json syntax
jq . ~/.mcp.json

# Check file permissions
ls -la ~/.mcp.json
```

### Problem: VPS Connection Failed

```bash
# Test SSH connection
ssh -i ~/.ssh/founderos_deploy -v root@95.217.162.12 "echo ok"

# Check key permissions
ls -la ~/.ssh/founderos_deploy
chmod 600 ~/.ssh/founderos_deploy
```

### Problem: Ollama Not Responding

```bash
# On VPS, check service
sudo systemctl status ollama
sudo systemctl restart ollama

# Test locally
curl http://localhost:11434/api/tags

# Check port
netstat -tuln | grep 11434
```

See `docs/VPS-MCP-SETUP.md` for comprehensive troubleshooting.

---

## 📚 Next Steps

1. **NOW:**
   - [ ] Review this file and `docs/VPS-MCP-SETUP.md`
   - [ ] Run `./scripts/check-mcp-status.sh` locally
   - [ ] Rotate your 3 exposed API keys

2. **TODAY:**
   - [ ] Run `./scripts/deploy-mcp-to-vps.sh`
   - [ ] SSH to VPS and edit `/root/.founderos/vps-env.sh`
   - [ ] Restart Claude service: `sudo systemctl restart founderos`

3. **VERIFY:**
   - [ ] Run status checker on both local & VPS
   - [ ] Test MCPs in Claude locally and on VPS
   - [ ] Commit changes: `git add -A && git commit -m "feat(mcp): global MCP deployment + VPS setup"`

---

## 📖 Related Documentation

- [VPS MCP Manual Setup](./VPS-MCP-SETUP.md) — Step-by-step guide
- [FounderOS CLAUDE.md](../CLAUDE.md) — Project standards
- [MCP Official Documentation](https://modelcontextprotocol.io/) — MCP spec
- [GitHub MCP](https://github.com/modelcontextprotocol/servers/tree/main/src/github) — GitHub server docs

---

**Questions?** Check the troubleshooting section or refer to the manual setup guide.  
**Ready to deploy?** Run: `./scripts/deploy-mcp-to-vps.sh`
