# FounderOS — The 8 Departments

> Each department is an autonomous AI agent with a specific scope, a specific set of tools, and a clear rule about which actions require your approval. No tool belongs to two departments. This is intentional.

---

## Why Departments?

The alternative to departments is a single general-purpose agent with all tools. This fails in production for three reasons:

1. **Tool confusion:** A 15-tool agent given "send me the research summary" doesn't know whether to use `send_email`, `send_file`, or just reply. Fewer, scoped tools per agent = deterministic routing.
2. **Security blast radius:** If the agent that reads GitHub issues (exposed to attacker-influenceable text) also has `run_shell`, you've assembled the lethal trifecta: untrusted input + private data + ability to act. Separate departments limit blast radius.
3. **Routing clarity:** The supervisor's job is easier when departments have clear, non-overlapping scopes. "Post to LinkedIn" → marketing. Always. No ambiguity.

Each department is implemented as a LangGraph `createReactAgent` — a model in a Reason-Act loop that calls tools until it completes the task or hits a HITL gate.

---

## Department 1: Research

**Scope:** Information gathering — web, internal knowledge base, anything that is read-only.

| Tool | Description | HITL? |
|---|---|---|
| `search_web` | Firecrawl web search | No |
| `search_knowledge` | Turicks-brain knowledge base | No |
| `read_emails` | Gmail inbox reader (read-only) | No |

**Design note:** Research is entirely read-only. It can never modify anything. This is why HITL is never required — the worst case is an irrelevant search result.

**Why `read_emails` is in research, not comms:**  
The inbox is an information source. "Summarize my emails from this week" is a research task. Sending email is a comms task. These are different actions with different risk profiles.

**The prospecting merger:**  
FounderOS v1 had a separate `prospecting` department for ICP scoring. We removed it when we realized it had zero tools that `research` didn't already have. ICP scoring is just web research with a specific framing. Adding a department for it created routing collisions (when should "research this company" go to research vs. prospecting?) with no benefit.

---

## Department 2: Comms

**Scope:** Your communications stack — email and calendar.

| Tool | Description | HITL? |
|---|---|---|
| `send_email` | Gmail send via Composio | ✅ Always |
| `create_calendar_event` | Google Calendar via Composio | ✅ Always |

**Why both tools are always HITL-gated:**  
Email and calendar events are visible to other people. There is no "undo" for an email that has been sent. HITL is mandatory.

**Why `linkedin_post` is NOT in comms:**  
LinkedIn posting was originally in both comms and marketing, creating a routing collision. "Post this on LinkedIn" sometimes went to comms (because it felt like outreach), sometimes to marketing (because it felt like content). The fix: LinkedIn is a marketing channel and lives exclusively in the marketing department. Every tool has exactly one owner.

**Composio vs. building our own integrations:**  
Gmail and Google Calendar have OAuth flows that take days to implement correctly, and refresh token handling that breaks in subtle ways. Composio manages all of this with a single connection ID. The trade-off: we depend on Composio's uptime. The benefit: the integration works on day one and stays working.

---

## Department 3: Engineering

**Scope:** Code and repositories — reading/writing GitHub, running commands in `~/Projects`, invoking Claude Code.

| Tool | Description | HITL? |
|---|---|---|
| `github_read` | Read repos, issues, PRs, file contents | No |
| `github_write` | Create issues, open PRs, push files | ✅ Always |
| `project_workflow` | `read_file`/`list_files` (instant) + `run_command` (gated) | `run_command` always |
| `claude_code` | Invoke Claude Code CLI for complex engineering tasks | No |

**Why `project_workflow` exists as a separate tool from `personal`:**  
`personal` is for laptop operations (documents, photos, Desktop, Downloads). `engineering` is for software project operations (`~/Projects/`). They are different trust domains. A bug in personal tooling shouldn't affect code repositories. Separate tools, separate path guards, separate HITL logic.

**The `run_command` tool output limit:**  
`run_command` output is capped at 2,000 characters before it is added to conversation history. This was reduced from 10,000 characters after a production bug: `pnpm test` returned 5,252 characters. When this appears multiple times in a multi-step engineering chain (branch → write → test → commit), the accumulated output overflows Gemini's context window, causing a 400 "contents is not specified" error. 2 KB per command × 5-step chain = 10 KB total — well within Gemini's limits.

**The `claude_code` tool:**  
For complex engineering tasks that require reading multiple files, understanding codebase patterns, and making targeted edits, engineering can invoke Claude Code CLI directly. This was added after a production hallucination where the supervisor replied "I don't have Claude Code access" — the tool existed but the supervisor didn't know about it. The fix was a `SELF-KNOWLEDGE` section in the supervisor prompt.

**Why engineering and personal stay separate (ADR-013):**  
If we merged personal tools into engineering, the engineering agent would have: `github_write` (cloud actions) + `run_shell` (local machine actions), while processing GitHub issues and PR descriptions that could contain prompt injection attempts. This is the "lethal trifecta": untrusted input + private data access + ability to act/exfiltrate. Separation is a security boundary, not an aesthetic choice.

---

## Department 4: Marketing

**Scope:** Content strategy, LinkedIn posts, brand-aligned messaging.

| Tool | Description | HITL? |
|---|---|---|
| `linkedin_post` | Post to LinkedIn via Composio | ✅ Always |
| `search_web` | Research for content ideas | No |
| `search_knowledge` | Brand guidelines and past content | No |

**Why marketing has its own `search_web` instead of routing through research:**  
A marketing task like "write a LinkedIn post about LangGraph" needs web research as a sub-step, not a full research department invocation. Giving marketing `search_web` lets the marketing agent complete the task in one department call. Routing to research first would require multi-department chaining, which the supervisor handles but at the cost of latency and complexity.

**The brand validator:**  
Before every LinkedIn post, a brand validator checks for banned phrases (generic AI marketing language, vague promises, certain competitor mentions). The validator was added after a production incident where the model drafted content that violated brand guidelines. The fix was to inject the `BRAND_BANNED_SECTION` into the marketing prompt upfront — not as a post-hoc check, but as a first-read constraint.

---

## Department 5: Sales

**Scope:** Cold outreach to leads — research, hook generation, email drafting.

| Tool | Description | HITL? |
|---|---|---|
| `search_web` | Research target companies/contacts | No |
| `send_email` | Cold email via Composio Gmail | ✅ Always |
| `search_knowledge` | Turicks ICP rules and past outreach patterns | No |

**The ICP gate:**  
Sales has a soft gate that checks whether a target matches the Turicks ICP (AI-adjacent companies, 2-10 person teams, technical founders). If the target doesn't match, the approval card includes a flag — but the agent always drafts when the founder explicitly requested outreach. The gate was softened after a production issue where the agent refused to draft at all for edge-case targets.

**Why send_email is in both sales and comms:**  
Sales emails are cold outreach to new contacts. Comms emails are to known contacts (replies, follow-ups, scheduling). They use the same underlying Gmail tool but with different context: sales attaches ICP scoring and an outreach hook, comms is conversational. Different departments, same underlying tool.

---

## Department 6: Personal

**Scope:** Your Mac laptop — files, shell commands, browser, file sharing to Telegram.

| Tool | Description | HITL? |
|---|---|---|
| `read_file` | Read file contents | No |
| `list_dir` | List directory contents | No |
| `write_file` | Write or overwrite files | ✅ Always |
| `run_shell` | Execute shell commands | ✅ Always |
| `browser` | Browser automation (deferred: Safari-MCP) | ✅ Always |
| `send_file` | Attach and send files to your Telegram chat | ✅ Always |

**The path guard:**  
Every personal tool call passes through `src/infra/path-guard.ts`. This module:
- Confines all operations to `$HOME`
- Blocks read AND write access to secrets: `.ssh/`, `.aws/`, `.env`, `*.pem`, `*.key`, Keychain files, `/etc`, `/private`, `/tmp`
- Resolves symlinks before checking (macOS: `/tmp` → `/private/tmp`, which is blocked)
- Rejects directory traversal (`../../etc/passwd`)

The secret-blocking rule applies even on read. An agent that can read `.ssh/id_rsa` can exfiltrate it by sending it via `send_email` in the same request. The guard prevents the first step.

**The `send_file` tool:**  
`send_file` delivers an actual file to your Telegram chat as a Telegram document. It is distinct from `read_file` (which shows text in the chat). The use case: "send me the report.pdf from my Desktop" → the file arrives as a downloadable attachment.

`send_file` has its own security check (`resolveSendableFile`) that runs the path guard plus additional checks: rejects directories, rejects empty files, rejects files over 50 MB (Telegram's limit), and blocks all the same secret paths as the path guard.

**Why personal and engineering are separate (again):**  
See engineering department notes. The separation is a security boundary enforced at the department level. The supervisor can sequence them (research → personal → engineering in one conversation), but they never share tools.

---

## Department 7: Jobhunt

**Scope:** Job search, CV reading, application drafting.

| Tool | Description | HITL? |
|---|---|---|
| `read_cv` | Read career data from personal-rag RAG (localhost:8765) | No |
| `search_jobs` | Search job listings via Firecrawl | No |
| `send_email` | Send job applications via Gmail | ✅ Always |

**The personal-rag boundary:**  
`read_cv` reads from a separate ChromaDB instance (`personal-rag`) that contains career data, portfolio details, and the founder's CV. This store is read-only from within FounderOS — jobhunt can read it but never write to it. It is also completely separate from `turicks-brain` (the business knowledge store). These stores must never cross-write (ADR-013/015).

**Why jobhunt is a separate department and not part of personal:**  
Jobhunt has a distinct purpose (career advancement), distinct data sources (personal-rag), and a HITL-gated outbound action (send application). Merging it into personal would make personal's scope too broad — "laptop ops" vs. "laptop ops + career management" are different mental models with different trust implications.

---

## Department 8: Memory (Supervisor-Level)

The memory tools are available to the supervisor, not a department. They provide episodic context across conversations.

| Tool | Description |
|---|---|
| `search_memory` | Semantic search over past decisions and session summaries |
| `record_event` | Log a significant event or decision for future retrieval |
| `read_context` | Read current business context (company bio, ICP, goals) |
| `update_context` | Update business context when the founder shares new information |

**Why memory lives with the supervisor:**  
Memory provides cross-conversation context — "what did we decide about the LinkedIn strategy last week?" This is a supervisor-level concern. Departments shouldn't be able to overwrite context arbitrarily; only the supervisor, which has the full conversation view, should update persistent state.

---

## The One-Owner Rule

Every tool has exactly one department owner. This was established after a production incident where `linkedin_post` was registered in both comms and marketing, causing routing collisions and unpredictable behavior.

The rule: if two departments seem to need the same tool, ask whether they are actually the same department or whether one of them needs a differently scoped version of the tool.

**Example:** Both sales and comms use `send_email`. But they're not duplicates — sales attaches ICP scoring context, comms is conversational. They call the same underlying Gmail integration but represent different use cases with different prompt context. This is fine.

**Counter-example:** `linkedin_post` in both comms and marketing was a true duplicate. The same tool, the same action, the same LinkedIn connection. Removed from comms, kept in marketing.

---

*For the decisions behind department design, see [DECISIONS.md](./DECISIONS.md). For security details on path guards and HITL gates, see [SECURITY.md](./SECURITY.md).*
