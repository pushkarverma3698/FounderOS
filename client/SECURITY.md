# FounderOS — Security Model

> FounderOS is a Telegram-controlled agent with access to your email, GitHub, LinkedIn, and Mac filesystem. This document explains exactly what can and cannot happen, and why.

---

## The Threat Model

FounderOS sits at a high-risk intersection:

- It ingests **untrusted content** — email, web pages, GitHub issues, PR descriptions (all can be written by adversaries)
- It has access to **sensitive capabilities** — file system, shell, outbound email, social media posting
- It is controlled via **a consumer messaging app** (Telegram) — not a hardened admin console

The primary threat is **prompt injection**: an attacker embeds instructions in content that FounderOS will process, causing it to take an action the founder didn't authorise. The secondary threat is **exfiltration**: an agent with read access to secrets also having a path to send them externally.

Every security control in FounderOS is designed against one or both of these threats.

---

## Security Layer 1 — Human Approval for Every Real-World Action

**What it is:** Before any action that affects the outside world, FounderOS pauses and sends an approval card to Telegram. The founder approves or rejects. Nothing executes without an explicit ✅.

**Implementation:** LangGraph's native `interrupt()`. When a HITL-gated tool is called, the agent pauses execution, serialises the full graph state to Postgres, and sends the approval card. On ✅, `Command({ resume: "approved" })` continues from exactly where it stopped. On ❌, `Command({ resume: "rejected" })` returns a rejection message.

**Why it's crash-safe:** The approval state is written to Postgres *before* `interrupt()` is called. If the process crashes between writing and calling, the approval is not lost — it's in the `interrupt_registry` table and can be recovered on restart. This is CLAUDE.md Rule #4: always write to `interrupt_registry` BEFORE calling `interrupt()`.

**What requires approval:**

| Action | Department | Why |
|---|---|---|
| Send email | comms, sales, jobhunt | External, irreversible, visible to other people |
| Create calendar event | comms | External, visible to attendees |
| GitHub write (issues, PRs, pushes) | engineering | Modifies shared codebase, visible externally |
| Write file | personal | Modifies local filesystem |
| Run shell command | personal | Can execute arbitrary code |
| Browser automation | personal | Interacts with web services |
| Send file to Telegram | personal | Exfiltrates local file to chat |
| LinkedIn post | marketing | Public content, irreversible |

**What does NOT require approval:**

| Action | Reason |
|---|---|
| Web search | Read-only, no side effects |
| Read file | Read-only, path-guarded |
| List directory | Read-only, path-guarded |
| Read emails | Read-only access to inbox |
| Read GitHub | Read-only, public or already-authorised repos |
| Search knowledge base | Read-only internal lookup |
| Search memory | Read-only internal lookup |

The rule: **if it changes state outside FounderOS, it requires approval.** There are no exceptions.

---

## Security Layer 2 — Path Guard (Filesystem Confinement)

**What it is:** `src/infra/path-guard.ts` validates every file path and shell working directory before any personal department tool executes.

**What it blocks:**

```
Blocked paths (read AND write):
  .ssh/           → SSH private keys
  .aws/           → AWS credentials
  .env, *.env     → Environment secrets
  *.pem, *.key    → TLS and crypto keys
  *.p12, *.pfx    → Certificate files
  .gnupg/         → GPG keys
  Library/Keychains/  → macOS Keychain
  /etc/           → System config
  /private/       → macOS system (includes /private/tmp)
  /tmp/           → Symlinks to /private/tmp on macOS
  /var/           → System data
  /usr/           → System binaries

Blocked patterns:
  ../             → Directory traversal attempts
  ~/../           → Escaping home directory
  Absolute paths outside $HOME
```

**The macOS `/tmp` gotcha:**  
On macOS, `/tmp` is a symlink to `/private/tmp`. `path.resolve('/tmp/file')` returns `/private/tmp/file`. The path guard resolves symlinks *before* checking, so a path that appears to be in a safe location isn't checked against its apparent path but against its real path. This burned us in testing — temp files created under `/tmp` failed the guard because `/private` is in the blocked list.

**Why secrets are blocked even on read:**  
The naive assumption is that reading a file is safe because "reading doesn't change anything." This is wrong in the context of an agent. A sequence of: `read_file("~/.ssh/id_rsa")` → `send_email(body=content)` exfiltrates the key in a single request. The path guard blocks the read step — the agent never has the key to leak.

**Confinement boundary:**  
All personal operations are confined to `$HOME` (`~/`). This means the agent can operate across Documents, Desktop, Downloads, and project folders, while never reaching system directories, other user accounts, or application sandboxes.

---

## Security Layer 3 — Idempotency (Preventing Double-Sends)

**What it is:** Before every external action (email send, LinkedIn post, GitHub push), FounderOS computes an idempotency key from the action parameters. If that key already exists in the `action_log` table, the action is skipped and the prior result is returned.

**Why this exists:**  
LangGraph's `interrupt()` pattern has a quirk: when a tool is resumed after HITL approval, the tool function re-executes from its beginning. Code above the `interrupt()` call runs again. Without an idempotency check, approving an action twice would send the email twice.

**How it works:**

```typescript
// Before every external action:
const key = sha1(JSON.stringify({ action: "send_email", to, subject, body }))
if (await hasBeenAudited(key)) {
  return { success: true, message: "Already sent (idempotent)" }
}
// ... execute the action ...
await writeAuditEntry({ action, idempotency_key: key, payload })
```

**Why SHA-1 and not a random UUID:**  
A UUID would be different every run, so a retry after a crash would generate a new UUID and send the email again. We need the key to be deterministic — the same email parameters always produce the same key, so a retry for the same email is always caught.

**What's covered:**

| Action | Idempotency key inputs |
|---|---|
| `send_email` | to + subject + body |
| `linkedin_post` | post content + timestamp |
| `github_write` | repo + branch + file path + content |
| `create_calendar_event` | title + start + end + attendees |

---

## Security Layer 4 — Department Isolation (Blast Radius Limiting)

**What it is:** Each department has only the tools it needs for its specific purpose. No department has all tools. The supervisor — which processes the raw Telegram message — has no dangerous tools at all.

**The lethal trifecta prevention:**  
The engineering department reads GitHub issues and PR descriptions, which can be written by external parties. Engineering must never have:
- `run_shell` — would allow an attacker to embed shell commands in a GitHub issue
- `write_file` — would allow file system modification via GitHub content
- `send_file` — would allow credential exfiltration via GitHub content

Engineering has: `github_read`, `github_write` (HITL-gated), `project_workflow` (path-guarded, `run_command` HITL-gated), `claude_code`.

The personal department reads the founder's filesystem, which is trusted. Personal must never have:
- `github_write` — not needed, and mixing cloud + local write access in one agent increases blast radius

**The supervisor's tool restriction:**  
The supervisor has only: `read_context`, `update_context`, `search_memory`, `record_event`. It routes messages and maintains business context. It cannot send email, cannot write files, cannot run shell commands. Even if the supervisor is confused by an adversarial message, it cannot take a harmful action — it can only route to a department that has the relevant tool, which will then require HITL approval.

---

## Security Layer 5 — The `send_file` Security Chain

**What it is:** The `send_file` tool has a dedicated security function (`resolveSendableFile`) that runs additional checks beyond the path guard before sending any file to Telegram.

**The full check sequence:**

1. Resolve the path (normalize `~/`, expand `$HOME`)
2. Run path guard — blocks secret paths, system directories, traversal
3. Confirm the path points to a file (not a directory)
4. Confirm the file exists
5. Confirm the file is not empty
6. Confirm the file is under 50 MB (Telegram's document limit)
7. Confirm the file extension is not on the blocked list (`.pem`, `.key`, `.env`, `.p12`, etc. — belt and suspenders)

Only then does the HITL approval card appear. Only after approval does `sendDocument()` execute.

**Why the belt-and-suspenders extension check:**  
The path guard blocks known secret *directories* (`.ssh/`, `.aws/`). But a key file stored in an unexpected location — `~/Desktop/my-key.pem` — wouldn't be caught by a directory check. The extension check catches it.

---

## Security Layer 6 — Environment Variable Validation

**What it is:** `src/core/config.ts` validates all required environment variables at startup using Zod. If a required variable is missing or malformed, the process exits immediately with a clear error.

**Why this matters for security:**  
Missing API keys cause two failure modes:
1. **Visible failure** — the action errors and the founder knows. Safe.
2. **Silent failure** — the action appears to succeed but didn't (e.g., an empty API key might cause a tool to return a stub response). Dangerous.

The Zod check at startup prevents both by making the missing-key condition an immediate, loud failure rather than a silent runtime error.

**What's validated:**  
All third-party credentials (Firecrawl, Composio, Telegram, LangSmith), database URL, model name, optional keys with their expected formats. Unknown keys are warned. Extra keys are allowed (for local development).

---

## The Security Audit Trail

Every external action that executes produces an audit log row in the `action_log` table:

```sql
CREATE TABLE action_log (
  id              SERIAL PRIMARY KEY,
  idempotency_key VARCHAR(64) NOT NULL UNIQUE,  -- SHA-1 of action params
  action          VARCHAR(128) NOT NULL,         -- e.g. "send_email"
  tenant          VARCHAR(64) NOT NULL,
  payload         JSONB,                         -- full action params
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
```

This gives a permanent, queryable record of everything FounderOS has ever done. "Did we send this email last week?" → query `action_log`. "How many LinkedIn posts this month?" → query `action_log`.

---

## What FounderOS Cannot Do

These are hard limits, enforced in code:

| Capability | Why Blocked |
|---|---|
| Access files outside `$HOME` | path-guard, unconditional |
| Read `.ssh/`, `.aws/`, `.env`, `*.pem` | path-guard, blocked on read |
| Send files > 50 MB | `resolveSendableFile` size check |
| Take any external action without approval | HITL gate on all write tools |
| Repeat an approved action without re-approval | Idempotency key prevents it |
| Execute on behalf of a different user | Single-tenant; `TENANT` is a constant |
| Access other user accounts on the machine | `$HOME` confinement |

---

## Known Limitations

**Prompt injection is a known, managed risk — not an eliminated one.**  
The path guard, HITL gates, and department isolation reduce the blast radius of a successful injection attack, but they don't prevent the model from being confused by adversarial content. Mitigation: every consequential action requires explicit founder approval. An injected instruction that causes the agent to draft a malicious email is caught at the HITL gate.

**The browser tool is currently an MVP.**  
The `browser` tool uses AppleScript automation. It is HITL-gated. Full Safari-MCP integration (headless WebKit with richer automation capabilities) is deferred to Phase 2 (ADR-012). Until then, browser automation requires the founder's graphical session to be active.

**GitHub write operations use a personal access token.**  
The GitHub integration uses a PAT with repo scope. A compromised `GITHUB_TOKEN` environment variable would give write access to configured repositories. Mitigation: store the PAT in a `.env` file that is in `.gitignore` and blocked by the path guard.

---

*For how these security controls fit into the broader architecture, see [ARCHITECTURE.md](./ARCHITECTURE.md). For the ADRs that established these controls, see [DECISIONS.md](./DECISIONS.md) (ADR-012, ADR-013).*
