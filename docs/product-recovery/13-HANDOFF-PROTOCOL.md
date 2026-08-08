# Handoff Protocol

The context problem this program diagnoses applies to the program itself. **No implementing
session loads the strategy conversation, and no session loads all twelve phases.**

---

## What each session loads

```
              THESIS  ─────────  (this session only, never again)
                 │
                 ▼
        00-MISSION.md  +  11-12-PHASE-TRANSITION.md § current phase
                 │
                 ▼
        the 1–2 audit docs that phase cites
                 │
                 ▼
        the failure-ledger entries that phase owns
                 │
                 ▼
        repository code in scope
```

**Context narrows as execution gets closer.** That is the design.

### Sonnet — implementation session

| Load | Do not load |
|---|---|
| `00-MISSION.md` (1 page) | the five strategy documents |
| The current phase, that section only | other phases |
| Audit docs that phase cites (max 2) | the other audit docs |
| Ledger entries the phase owns | the full ledger |
| Code in scope | the whole repo |

**Opening move:** re-verify the phase's Evidence section against the live system before
implementing. Evidence ages. If it no longer holds, **stop and report** — do not adapt the plan
alone (rule #28: approval authorizes work, it does not verify it).

### Antigravity — validation session

| Load | Do not load |
|---|---|
| `10-REALITY-BENCHMARK.md` | any phase document |
| The task IDs this phase gates on | the audit docs |
| Telegram access | the repository |

**Antigravity must not know how the phase was implemented.** It behaves as the founder: types
sentences, records what happens. Knowing the implementation is how a validator learns to
accommodate it.

---

## Session boundaries

One session = one phase, or one phase-part. When a session ends:

1. Update the phase's status in `11-12-PHASE-TRANSITION.md` with **real numbers**
2. Append new defects to `12-FAILURE-LEDGER.md` — do not fix out-of-scope findings
3. Write the handoff (below)
4. **Start a fresh session for the next phase**

Do not carry a session across phases. Commitment inertia is real: a session that spent three
hours defending a design will not overturn it on new evidence.

---

## Handoff template

```md
## Phase N handoff — YYYY-MM-DD

**Status:** COMPLETE | BLOCKED | PARTIAL

**Exit criteria**
| Criterion | Met | Evidence (command + output) |
|---|---|---|

**Changed:** files + one line each
**Verified:** commands run this session, with output
**NOT verified:** what was claimed but not proven, and why
**New defects:** ledger IDs added
**Next phase needs to know:** ≤5 lines
```

---

## Rules binding on every implementing session

1. **Evidence, or say NOT VERIFIED.** A command run in-session with output shown, or the claim
   does not ship. (`CLAUDE.md` #24)
2. **No scope expansion.** A defect found outside the phase goes in the ledger, not in the diff.
   (`CLAUDE.md` #26 / "Finish Before You Widen")
3. **No new abstraction** unless the phase names one. Four subsystems in this repo were built,
   tested, and wired to nothing — every one was added during a repair.
4. **Bug fixes start with a failing test.** Especially F-01: write the fixture that reproduces the
   100% drop before touching the filter.
5. **Small work goes straight to the fix.** A wiring fix does not get a design document. Ceremony
   on a two-line change is the documented failure, not diligence.
6. **The implementer does not score its own phase.** (`CLAUDE.md` #29)
7. **Prod is prod.** Read before you write. `ssh founderos-vps`, non-disruptive reads first.

---

## Anti-patterns this protocol exists to prevent

| Anti-pattern | Precedent |
|---|---|
| Loading the whole strategy conversation into every session | the context problem being fixed |
| One long session across many phases | commitment inertia; compaction drift |
| Implementer validates itself | rule #29, written from a measured failure |
| Fixing unrelated bugs mid-phase | untraceable diffs |
| Building a second X because the first is hard to find | ContextComposer (F-10) |
| Declaring done on green tests | F-03, the entire reason for this program |

---

## Where the program's state lives

| Artifact | Holds |
|---|---|
| `11-12-PHASE-TRANSITION.md` | phase status + real numbers |
| `12-FAILURE-LEDGER.md` | every known defect and its owner |
| `benchmark-runs/*.md` | scored benchmark runs over time |
| `handoffs/phase-N.md` | one per session |

**Not in any model's context. In the repository.**

> Per `CLAUDE.md`: if any file under `docs/` changed this session, run `pnpm brain:sync` before
> concluding.
