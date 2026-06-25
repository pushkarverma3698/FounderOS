# 04 — Department & Tool Map

Which department owns which tool, and what's gated. This is the single source of
truth [`src/agents/capabilities.ts`](../../src/agents/capabilities.ts) drawn out.
**A tool has exactly one owner department** — that's what keeps routing
collision-free. `*` = pauses for founder approval (HITL).

```mermaid
graph LR
  sup["Supervisor (Chief of Staff)<br/>NO TOOLS — routes only (ADR-028)<br/>outputMode: last_message (ADR-021)"]:::sup

  sup --> admin & research & comms & engineering & marketing & sales & personal & jobhunt

  admin["admin"]:::dept
  research["research"]:::dept
  comms["comms"]:::dept
  engineering["engineering"]:::dept
  marketing["marketing"]:::dept
  sales["sales"]:::dept
  personal["personal"]:::dept
  jobhunt["jobhunt"]:::dept

  admin --> a1[read_context] & a2[update_context] & a3[search_memory] & a4[record_event*] & a5[list_pending_signals]
  research --> r1[search_web] & r2[search_knowledge] & r3[search_turicks_brain] & r4[publish_signal]
  comms --> c1[send_email*] & c2[read_emails] & c3[create_calendar_event*]
  engineering --> e1[github_read] & e2[github_write*] & e3[project_workflow*] & e4[claude_code*] & e5[apply_cinematic_preset*] & e6[deploy_static_site*] & e7[publish_signal]
  marketing --> m1[search_web] & m2[linkedin_post*] & m3[search_knowledge] & m4[search_turicks_brain] & m5[publish_signal]
  sales --> s1[send_email*] & s2[search_web] & s3[search_knowledge] & s4[search_turicks_brain]
  personal --> p1[read_file] & p2[list_dir] & p3[send_file*] & p4[write_file*] & p5[run_shell*] & p6[browser*] & p7[search_personal_rag] & p8[search_turicks_brain]
  jobhunt --> j1[read_cv] & j2[search_jobs] & j3[send_email*] & j4[search_personal_rag]

  classDef sup fill:#8b5cf6,stroke:#5b21b6,color:#fff
  classDef dept fill:#3b82f6,stroke:#1e40af,color:#fff
```

**Ownership notes (why a tool lives where it does)**
- **Supervisor has NO tools** (ADR-028: Chief of Staff routes only). Business context,
  memory, and signal visibility all live in the `admin` department.
- `search_web` / `search_knowledge` / `search_turicks_brain` are **shared read tools** —
  they appear in several departments because they're cheap, stateless reads with no
  collision risk. Every *write/send* tool has a single owner.
- `admin` owns `read_context`, `update_context`, `search_memory`, `record_event`, and
  `list_pending_signals` — all internal coordination, no external side effects.
- `linkedin_post` lives in **marketing only** (was in comms — routing collision removed).
- `read_emails` lives in **comms only** (was in research — inbox data stays in its dept).
- `send_email` appears in comms, sales, and jobhunt — each uses `createSendEmailTool("dept")`
  which scopes the idempotency key and audit log per department.
- `search_personal_rag` → **personal + jobhunt only** — career data is founder-private.
  Not available to research, sales, or marketing (ADR-013/015).
- **prospecting was merged into research** — ICP scoring is a research *mode*, no unique tool.
- `claude_code` is engineering's primary executor: a full Claude Code coding agent
  (files, shell, git, gh) in an isolated workspace.
- `browser` is Safari automation on the founder's Mac (personal dept, path-guarded).
- `publish_signal` in research/marketing/engineering: internal coordination write to
  `dept_signals` table — not HITL-gated (no external side effect, ADR-024).

**Adding a tool touches 6 layers** (see [`docs/rules/PROGRAMMING-RULES.md`](../rules/PROGRAMMING-RULES.md)):
`src/tools/{name}.ts` → test → `agent-tools/{dept}.ts` wrapper → `agent-tools.ts`
barrel → `capabilities.ts` (DEPARTMENT_TOOLS array) → `system-prompts.ts`.
The supervisor's capability manifest auto-regenerates from `capabilities.ts` — no
hand-maintained prompt prose that can drift from reality.
