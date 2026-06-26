# MCP Server Gallery — add a tool in 3 steps

FounderOS agents can consume any external **MCP server** (ADR-041). This is the "add keys and go" surface: you declare a server in a JSON manifest, drop in its keys, and the agent gains the tool — **reads pass through, writes are HITL-gated automatically**. No code, no 6-layer tool wiring.

This is the same idea as OpenClaw's plugin configs or a Claude Desktop `mcpServers` block — but with FounderOS's safety rails (idempotency + founder approval + audit) wrapped around every write.

---

## Quickstart (3 steps)

1. **Declare the server.** Copy a block from [`mcp-bridge.example.json`](../../mcp-bridge.example.json) into your `mcp-bridge.json` (the file `MCP_BRIDGE_MANIFEST` points at; default `mcp-bridge.json` in the repo root).
2. **Add the keys.** Put the env vars listed in the block's `env` array into your `.env` (or `PROD_DOTENV` secret). Secrets never live in the manifest — only the **names** of the env vars to forward.
3. **Turn it on + restart.**
   ```bash
   MCP_BRIDGE_ENABLED=true
   # restart the bot — prod: `sudo systemctl restart founderos`
   ```
   At boot you'll see one line per server confirming the classification:
   ```
   MCP server bridged { server: "slack", tools: 5, departments: ["comms"],
     classified: ["slack_post_message=WRITE", "channels_list=READ", …] }
   ```
   **Verify that line** — if a destructive tool is marked `READ`, fix the server's `write` list and restart.

> Default OFF: with `MCP_BRIDGE_ENABLED` unset/`false` the build is byte-identical — zero runtime cost until you opt in.

---

## Manifest fields

| Field | Required | Meaning |
|---|---|---|
| `command` + `args` | yes | The executable to spawn (`npx`, `uvx`, `node`) and its args. stdio transport (local child process). |
| `department` | yes | Which department(s) receive the tools — a string or an array. Determines routing + which agent can call them. |
| `env` | no | **Names** of process env vars to forward to the child (values read from `process.env` at connect). Secrets stay out of the manifest. |
| `write` | no | Explicit allowlist of tool names that require founder approval (HITL). Everything else is read-through. **This is the one safety-critical decision** (rule #13/#16) — classification is data, not a guess. |
| `gateUnlisted` | no | `true` ⇒ any tool *not* in `write` is *also* gated ("unknown ⇒ require approval"). Use for a server whose tool surface you don't fully trust. Default `false`. |

A server that fails to start contributes **zero** tools and never blocks boot (failure isolation).

---

## The gallery (verified packages, 2026-06)

| Server | Package / command | Dept | Keys (`env`) | Writes (HITL-gated) |
|---|---|---|---|---|
| **Filesystem** | `npx @modelcontextprotocol/server-filesystem <dir>` | personal | — | `write_file`, `edit_file`, `move_file`, `create_directory` |
| **Git** | `uvx mcp-server-git --repository <path>` | engineering | — | `git_commit`, `git_add`, `git_create_branch` |
| **Fetch** | `uvx mcp-server-fetch` | research | — | _(read-only)_ |
| **Apify** | `npx @apify/actors-mcp-server --actors <ids>` | research | `APIFY_TOKEN` | _(read; scraping)_ |
| **Notion** | `npx @notionhq/notion-mcp-server` | admin, research | `NOTION_TOKEN` | `API-post-page`, `API-patch-page`, `API-patch-block-children` (+`gateUnlisted`) |
| **Slack** | `npx @modelcontextprotocol/server-slack` | comms | `SLACK_BOT_TOKEN`, `SLACK_TEAM_ID` | `slack_post_message`, `slack_reply_to_thread` |
| **Sequential Thinking** | `npx @modelcontextprotocol/server-sequential-thinking` | engineering | — | _(read-only reasoning aid)_ |
| **Blender** | `uvx blender-mcp` | personal | — | `execute_blender_code`, `render_image` |

**Apify** ties directly into the research/lead-gen flywheel — point `--actors` at the scrapers you want (e.g. `apify/instagram-scraper`, `apify/google-maps-scraper`, `apify/rag-web-browser`).

### Not recommended here
- **GitHub MCP** — the old `@modelcontextprotocol/server-github` is deprecated (moved to `github/github-mcp-server`). FounderOS already has native `github_read` / `github_write*` tools — use those.
- **Brave Search MCP** — archived from the reference set. Use the built-in `search_web`.

The long tail of servers lives in the **[MCP Registry](https://github.com/modelcontextprotocol/servers)** — anything there follows the exact same manifest pattern.

---

## Security model (why this is safe to hand to an agent)

1. **Allowlist, not heuristic.** A tool is a write **only** if its bare name is in that server's `write` array (`src/mcp/bridge-classify.ts`). No LLM guesses whether something is destructive.
2. **Every write goes through the same gate as native tools** — `hitlGate()` writes a DB approval row, `interrupt()` surfaces the founder's approve/reject card, and a successful action is written to `action_log` with an idempotency key. A bridged Slack post is as safe as a native `send_email`.
3. **Unknown servers contribute nothing.** Only servers you list in the manifest are connected; an unlisted server is simply absent.
4. **Boot-time transparency.** Every tool's READ/WRITE classification is logged at startup for review (the "classified: …" line above).
5. **Secrets never touch git.** The manifest holds env-var *names*; values come from `.env` / `PROD_DOTENV`.

See [ADR-041](../decisions/041-mcp-client-bridge.md) for the full design.
