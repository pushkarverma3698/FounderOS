# 04 — Department & Tool Map

Which department owns which tool, and what's gated. This is the single source of
truth [`src/agents/capabilities.ts`](../../src/agents/capabilities.ts) drawn out.
**A tool has exactly one owner department** — that's what keeps routing
collision-free. `*` = pauses for founder approval (HITL).

```mermaid
graph LR
  sup["Supervisor (Chief of Staff)<br/>read_context · update_context<br/>search_memory · record_event*"]:::sup

  sup --> research & comms & engineering & marketing & sales & personal & jobhunt

  research["research"]:::dept
  comms["comms"]:::dept
  engineering["engineering"]:::dept
  marketing["marketing"]:::dept
  sales["sales"]:::dept
  personal["personal"]:::dept
  jobhunt["jobhunt"]:::dept

  research --> r1[search_web] & r2[search_knowledge]
  comms --> c1[send_email*] & c2[read_emails] & c3[create_calendar_event*]
  engineering --> e1[github_read] & e2[github_write*] & e3[project_workflow*] & e4[claude_code*]
  marketing --> m1[search_web] & m2[linkedin_post*] & m3[search_knowledge]
  sales --> s1[search_web] & s2[send_email*] & s3[search_knowledge]
  personal --> p1[read_file] & p2[list_dir] & p3[send_file*] & p4[write_file*] & p5[run_shell*] & p6[browser*] & p7[search_personal_rag] & p8[search_turicks_brain]
  jobhunt --> j1[read_cv] & j2[search_jobs] & j3[send_email*]

  classDef sup fill:#8b5cf6,stroke:#5b21b6,color:#fff
  classDef dept fill:#3b82f6,stroke:#1e40af,color:#fff
```

**Ownership notes (why a tool lives where it does)**
- `search_web` / `search_knowledge` are **shared read tools** — they appear in
  several departments because they're cheap, stateless reads with no collision risk.
  Every *write/send* tool has a single owner.
- `linkedin_post` lives in **marketing only** (was duplicated in comms — removed).
- `read_emails` lives in **comms only** (was duplicated in research — removed).
- **prospecting was merged into research** — ICP scoring is a research *mode*, it
  carried no unique tool. (The auto-generated `.claude/graph-mermaid.md` still shows
  the old 8th department; this hand-authored map is current.)
- `claude_code` is engineering's primary executor: a full Claude Code coding agent
  (files, shell, git, gh) in an isolated workspace.
- `browser` is Safari automation on the founder's Mac (personal dept).

**Adding a tool touches 6 layers** (see [`docs/rules/PROGRAMMING-RULES.md`](../rules/PROGRAMMING-RULES.md)):
`src/tools/{name}.ts` → test → `agent-tools/{dept}.ts` wrapper → `agent-tools.ts`
barrel → `capabilities.ts` (department array + HITL set) → `system-prompts.ts`.
Because `capabilities.ts` is the single source, the supervisor's capability
manifest auto-regenerates — no prompt prose to hand-sync.
