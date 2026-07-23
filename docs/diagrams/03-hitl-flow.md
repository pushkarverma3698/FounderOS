# 03 — HITL Approval Flow

How founder approval gates every external action. HITL = native LangGraph
`interrupt()`, DB-backed and **crash-safe**: because graph state lives in the
Postgres checkpointer, a pending approval survives a process restart.

The cardinal rule: **the side effect runs only after an `approved` resume.** A
rejection — or a crash, or a stale card — is always a clean no-op.

```mermaid
sequenceDiagram
  autonumber
  actor F as Founder
  participant GW as Gateway (kernel-run)
  participant SUP as Supervisor (pure dispatch)
  participant DEPT as Worker agent
  participant TOOL as HITL-gated tool
  participant PG as Postgres (checkpointer)
  participant EXT as External API

  F->>GW: "email the client the proposal"
  GW->>SUP: office.invoke({messages})
  SUP->>DEPT: route (e.g. comms)
  DEPT->>TOOL: call send_email(draft)
  Note over TOOL,PG: write hitl_approvals row BEFORE interrupt (rule #4)
  TOOL->>PG: interrupt(ApprovalRequest)
  PG-->>GW: getState().tasks has interrupt
  GW-->>F: Approve / Reject card · STOP

  alt Approved
    F->>GW: tap ✅ → resumeOffice("approved")
    GW->>PG: Command({resume:"approved"})
    PG->>TOOL: resume past interrupt
    Note over TOOL,EXT: idempotency check (hasBeenAudited) BEFORE send (rule #5)
    TOOL->>EXT: perform send
    TOOL->>PG: writeAuditEntry(action_log)
    GW-->>F: ✅ result
  else Rejected
    F->>GW: tap ❌ → resumeOffice("rejected")
    GW->>PG: clearThreadCheckpoints (NEVER resume into agent)
    GW-->>F: ❌ Cancelled — nothing sent
    Note right of GW: action_log stays empty · no re-draft loop
  else Stale (new message arrives first)
    F->>GW: new free-text message
    GW->>PG: resolvePendingApproval → resume "rejected" (drain)
    GW-->>F: ⏸️ previous card cancelled, running new request
  end
```

**HITL-gated tools** (`HITL_GATED_TOOLS` in
[`capabilities.ts`](../../src/agents/capabilities.ts)) — every one pauses before acting:

`send_email` · `linkedin_post` · `github_write` · `write_file` · `run_shell` ·
`browser` · `send_file` · `claude_code` · `project_workflow` ·
`create_calendar_event` · `record_event`

**Why reject clears the thread:** a ReAct sub-agent treats the rejection
tool-result as feedback and re-drafts, firing `interrupt()` again forever (live
repro 2026-06-12). So reject is terminal: clear + confirm, never resume into the agent.
