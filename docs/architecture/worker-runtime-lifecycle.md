# Durable Worker Runtime & Lifecycle

> Milestone 3 of the FounderOS general-purpose AI OS migration.

This document describes the runtime lifecycle and durable persistence model for persistent digital workers in FounderOS.

## 1. Core Mission: Durable Living Workers

In Milestone 2, we built portable **Worker Contracts** that define *who* a worker is and *what* capabilities it holds.
Milestone 3 solves the durable execution layer:
> *How does a Worker live inside FounderOS over days and weeks, survive runtime crashes, wake up, resume, and maintain state across process reboots?*

Autonomous worker loops (observe-reason-plan-act) are deliberately deferred to Milestone 4. Milestone 3 provides the **operating system lifecycle harness**.

---

## 2. Architecture: Control Plane vs Ephemeral Runtime

```text
                     FOUNDEROS LIFECYCLE & SCHEDULER
                                   │
              ┌────────────────────┼────────────────────┐
              ▼                    ▼                    ▼
       wake() / sleep()     crashRecovery()      start() / stop() / pause()
              │                    │                    │
              └────────────────────┼────────────────────┘
                                   │
                                   ▼
                      WorkerRuntimeOrchestrator
                                   │
          ┌────────────────────────┼────────────────────────┐
          ▼                        ▼                        ▼
  WorkerSessionManager     WorkerLifecycleManager    WorkerContextProvider
 (active runtime session)  (valid FSM transitions)   (durable context bootstrap)
          │                        │                        │
          └────────────────────────┼────────────────────────┘
                                   │
                                   ▼
                       Worker Persistence Layer
                  (Drizzle queries + Postgres DB)
     ┌───────────────────┬───────────────────┬───────────────────┐
     ▼                   ▼                   ▼                   ▼
worker_contracts   worker_state    worker_sessions     worker_progress
(durable version)  (status+crash)  (liveness+sessions) (audit history)
```

### The Separation Rule
- **The Runtime Engine** (Antigravity, Claude Code, or Stub) is stateless and ephemeral. It can crash, run out of memory, or be terminated at any time without data loss.
- **FounderOS Postgres** holds the durable single source of truth: the active contract, current lifecycle status, session heartbeats, objectives, and progress logs.
- When a runtime crashes, FounderOS reclaims the worker and launches a fresh runtime session with the restored bootstrap context.

---

## 3. Finite State Machine (FSM) Lifecycle

The `WorkerLifecycleManager` enforces legal transitions using a strict adjacency list:

```text
              ┌──────────────┐
              │   CREATED    │
              └──────┬───────┘
                     │ configure()
                     ▼
              ┌──────────────┐
              │  CONFIGURED  │
              └──────┬───────┘
                     │ ready()
                     ▼
              ┌──────────────┐
       ┌─────►│    READY     │◄────┐
       │      └──────┬───────┘     │
       │             │ start()     │
       │             ▼             │
       │      ┌──────────────┐     │ resume()
       │      │   RUNNING    ├─────┤
       │      └──┬───┬───┬───┘     │
wake() │  sleep()│   │   │pause()  │
       │         │   │   ▼         │
       │         │   │ ┌─────────┐ │
       │         │   │ │ PAUSED  ├─┘
       │         │   │ └─────────┘
       │         ▼   │
       │  ┌─────────┐│
       └──┤ WAITING ││
          └─────────┘│
                     │ fail() / stop()
                     ▼
              ┌──────────────┐
              │STOPPED/FAILED│
              └──────────────┘
```

Transitions not explicitly permitted by `VALID_TRANSITIONS` are rejected loudly with descriptive errors.

---

## 4. Persistence Tables (Schema `agents`)

The following tables are migrated via `drizzle/0043_worker_runtime_persistence.sql`:

1. `agents.worker_contracts`: Stores full semver-versioned `WorkerContract` JSONs. Only one version per worker is marked `is_active = true`.
2. `agents.worker_state`: Tracks current lifecycle status (`CREATED`, `RUNNING`, `PAUSED`, `WAITING`, `STOPPED`, `FAILED`), active runtime provider, handle ID, recovery attempts, and last transition timestamp.
3. `agents.worker_sessions`: Tracks runtime execution sessions (`session_id`, `started_at`, `ended_at`, `last_heartbeat`, `metadata`). Enables liveness monitoring and stale session sweeping.
4. `agents.worker_objectives`: Relates worker objectives to high-level FounderOS `missions`.
5. `agents.worker_progress`: Audit log of progress reports and next actions.

---

## 5. Boot-Time Crash Recovery

When FounderOS crashes or restarts mid-flight:
1. `recoverStrandedWorkers()` runs during `src/index.ts` boot sequence alongside `recoverStrandedScheduledTasks()` and `recoverStrandedReminders()`.
2. Any worker left in `RUNNING` status has its crash signature evaluated:
   - **Attempts < 3:** Transitions to `PAUSED` with recovery counter bumped, allowing graceful resumption.
   - **Attempts >= 3:** Transitions to `FAILED` with `failure_reason: 'Stranded in RUNNING by crash; exceeded max recovery attempts'`, and logs loud telemetry alerts.
3. Database failure handling is **fail-open** (`try/catch` with logging) so a transient database glitch never prevents system startup.
