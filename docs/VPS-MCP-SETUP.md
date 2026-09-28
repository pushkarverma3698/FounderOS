# Connecting to the FounderOS hub (MCP) on the Production VPS

Every coding tool — Claude Code, Codex, Cursor, Antigravity, Gemini CLI — connects
to **one** MCP server, the FounderOS hub (`src/mcp/hub.ts`), running on the
production VPS against the production data:

| Tools | What they do |
|---|---|
| `search_memory`, `get_memory`, `remember`, `save_decision`, `save_bug` | the shared brain (`brain.brain_memories`) |
| `gmail_search`, `calendar_events` | read the founder's Google accounts (`src/core/accounts.ts`), one or all |
| `list_connected_tools`, `call_connected_tool` | every MCP server in `/opt/founderos/mcp-bridge.json`, read-only |

**Nothing in the hub sends or changes anything on the founder's behalf.** Sending
mail, creating events, and any tool a connected server marks as a write stay in
Telegram, where the founder approves them (ADR-004, ADR-013). Brain writes are the
one exception: they record decisions and bugs, not actions.

**Adding a server:** one entry in `/opt/founderos/mcp-bridge.json` on the VPS (or
`/connect` in Telegram). The hub re-reads the file on every call, so every tool
sees the server on its next call, with no restart and no laptop edit. Its write
tools are refused unless they go through Telegram.

**VPS access:** the `founderos` user via the `founderos-vps` SSH alias only.
Root SSH login is denied on the box. The project lives at `/opt/founderos`; the
bot service (`founderos.service`) and its secrets (`/opt/founderos/.env`) are
covered in [`PRODUCTION.md`](PRODUCTION.md) — this doc is scoped to the MCP
server only.

**The simple model: launch the stdio server on the VPS over SSH.** Your MCP
client runs `ssh founderos-vps '… node … src/mcp/hub.ts'`; JSON-RPC flows over
the SSH pipe. That means:

- **Your SSH key is the auth** — the same key you already use. No bearer token.
- **No open port, no tunnel daemon, no extra service** — the connection lives
  only while your client is running, and drops when it exits.
- **No secrets on your machine** — tool credentials are read from the VPS's own
  `/opt/founderos/.env`; the tools execute on the VPS.

```
Mac (MCP client) ──ssh founderos-vps──▶  VPS: node src/mcp/hub.ts (stdio)
   JSON-RPC over the SSH pipe                reads /opt/founderos/.env, runs tools
```

On the founder's laptop every tool starts the hub through one script,
`~/Projects/scripts/ai-tools/founderos-brain-mcp.sh`, so changing what the hub
serves never needs a config edit in five tools.

---

## One-time setup

1. **SSH host alias** — append `deploy/ssh-config.founderos-vps.example` to your
   `~/.ssh/config` (pins the `founderos_deploy` key to `founderos-vps`). Confirm:
   ```bash
   ssh founderos-vps 'echo ok && test -d /opt/founderos && echo found-founderos'
   ```
2. **MCP client config** — copy the `founderos-vps` block from
   `deploy/mcp-founderos-vps.example.json` into your client's config:
   - **Claude Code:** `claude mcp add -s user founderos-vps -- ssh founderos-vps '<command below>'`.
   - **Claude Desktop:** `claude_desktop_config.json`.
   ```jsonc
   {
     "mcpServers": {
       "founderos-vps": {
         "command": "ssh",
         "args": ["founderos-vps",
                  "cd /opt/founderos && LOG_STDERR=1 node --env-file=.env --import tsx/esm src/mcp/hub.ts"]
       }
     }
   }
   ```
   `LOG_STDERR=1` keeps logs off stdout so the JSON-RPC stream stays clean — it's
   already baked into `pnpm mcp:hub`; keep it in the SSH command too.
3. **Restart the client.** It spawns the SSH child on demand; the hub's tools
   appear as `search_memory`, `gmail_search`, etc.

## Brain-only access (`HUB_SCOPE=brain`)

An agent that must not read the founder's mail gets the hub with
`HUB_SCOPE=brain`: only the five brain tools, and a call to any other tool is
refused, not just hidden. On the VPS the `antigravity` user runs it this way with
its own env file, whose `DATABASE_URL` is the `brain_agent` Postgres role — that
role can read and write `brain.brain_memories` and nothing else, so the limit is
enforced by the database as well as by the hub. `src/mcp/turicks-brain.ts` is the
same hub in brain scope, kept for configs that still start it.

## Giving a colleague access

They need exactly two things — nothing FounderOS-specific to install:

1. SSH access to the VPS (their own key added to the VPS `authorized_keys`, or a
   shared deploy key) plus the `founderos-vps` alias from step 1.
2. The `founderos-vps` block from step 2 in their MCP client config.

No token to share, no port to open. Revoke access by removing their SSH key on
the VPS.

## Local Claude Code (same machine as the server)

Running a client on the VPS itself? `pnpm mcp:hub` — same tools, stdio, no SSH
hop (it sets `LOG_STDERR=1` for you). `src/mcp/index.ts` (`pnpm mcp`), the older
read-only server, still works, but no tool config uses it any more; the repo's
`.mcp.json` that started it against the laptop's own database was removed on
2026-09-28, because it gave Claude a second, stale memory next to the real brain.

---

## Verifying the connection

- **From the client side:** `claude --doctor` lists registered MCP servers and
  their status — confirm `founderos-vps` shows connected.
- **Manually:** run the exact SSH command from step 2 by hand. It should hang
  waiting for JSON-RPC on stdin (that's correct — the client normally supplies
  it); `Ctrl+C` to exit confirms the SSH hop and the `node` process both start
  cleanly.
- **On the VPS side:** if tools connect but calls fail, the server process
  itself logs to stderr (per `LOG_STDERR=1`) — tail it live with
  `ssh founderos-vps 'sudo journalctl -u founderos -f'` if you suspect the
  underlying data (Postgres, RAG stores) rather than the MCP transport.

## Troubleshooting

**`ssh: connect to host … port 22: Connection refused` or `Permission denied`**
Your `~/.ssh/config` alias or key is wrong — re-run the one-time setup step 1
confirmation command. Root login (`root@…`) is denied by design; only the
`founderos-vps` alias (resolving to the `founderos` user) works.

**Client shows `founderos-vps` but no tools appear**
Check the exact `args` array matches `deploy/mcp-founderos-vps.example.json` —
a stale `cd` path or missing `--env-file=.env` will start `node` in the wrong
directory or without the vars the tools need.

**Tools appear but calls error (e.g. "search_memory unavailable")**
That's a data/backend problem, not a transport problem — check
`/opt/founderos/.env` has the vars required for that tool (see
[`PRODUCTION.md`](PRODUCTION.md) § 6 "Required environment") and that the
underlying store (Postgres, etc.) is reachable from the VPS.

---

## If you later need it always-on

The on-demand SSH model above is right for "connect when required." If you ever
want the server **running 24/7** and reachable by multiple clients or non-SSH MCP
clients simultaneously, the always-on HTTP variant (loopback bind + bearer token
+ autossh tunnel + systemd) lived in git history at commit `f54e5a8` — restore it
from there rather than rebuilding.

---

## Related Docs

- [MCP Official Docs](https://modelcontextprotocol.io/)
- [FounderOS CLAUDE.md](../CLAUDE.md)
- [VPS Production Guide](./PRODUCTION.md) — the bot service, its secrets, and disaster recovery (out of scope here)
- [MCP topology spec §1.2](./plans/2026-07-14-MCP-TOPOLOGY-LANGGRAPH-STANDARDS-AGENCY-SCALE.md)
