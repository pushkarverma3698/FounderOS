---
paths:
  - "deploy/**"
  - "scripts/**"
  - ".github/workflows/**"
  - "src/infra/**"
---

# Prod VPS: operating detail

The always-loaded rules (alias, never edit `/opt/founderos`) are in `CLAUDE.md`. This file carries the detail.

- `ssh founderos-vps '<cmd>'` resolves to `founderos@95.217.162.12` (host `founder-os`) with key `~/.ssh/founderos_deploy`. `root@` login is denied.
- Passwordless sudo (`/etc/sudoers.d/founderos-nopasswd`): prefix privileged commands with `sudo -n`.
- Layout: project at `/opt/founderos`; `founderos.service` (systemd) runs the bot; `founderos-ollama` and `founderos-postgres` run under docker.
- Review checkouts go in `/opt/review/<repo>`. Run the MTProto probe from there, with env from `/opt/founderos/.env`.
- If `ssh founderos-vps` fails on a fresh machine, the operator adds the block from `deploy/ssh-config.founderos-vps.example` (branch `claude/mcp-vps-ssh-bridge`) and holds the key.
- This is prod with no second gate. Read before you write; verify before destructive commands.
- After merging to `main`, watch the deploy and confirm prod moved: check `systemctl show founderos -p ActiveEnterTimestamp`, not `git rev-parse HEAD`.
