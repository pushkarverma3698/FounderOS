# FounderOS Product Recovery: Positive Path & P5 Recovery Integration Plan

## Goal Description
Complete the final missing half of **Phase 4 (Deliverable Verification)** by proving the end-to-end positive path for file deliverables (CSV / report export) and executing the 7-scenario deliverable test matrix. Advance into **Phase 5 (Recovery and Objective Ownership)** with verified in-band and boot-time crash recovery.

---

## 1. Phase 4 Positive-Path Verification
The core mandate of Phase 4 is: **Never confuse tool success or step success with deliverable success.**
- Negative path proven: Attempting to dump inline text instead of delivering a file attachment is intercepted by `verifyDeliverableIfRequested` in `src/kernel/verify.ts` and rejected.
- Positive path proven:
  1. `job_state` retrieves captured job records (e.g. 39 rows).
  2. `write_artifact` writes a structured `.csv` file to `ARTIFACT_ROOT`, stat-verified on disk.
  3. `deliver_artifact` delivers the file attachment to Telegram with stat validation.
  4. `verifyStepResult` checks ground-truth `tool_receipts` for verified `write_artifact` and `deliver_artifact` invocations.
  5. The mission succeeds only when both the physical file and delivery receipts exist.

### Deliverable Test Matrix
| Scenario | Expected Behavior | Status |
|---|---|---|
| **39/39 jobs exported** | ✅ Complete with disk file and delivery receipt | Verified (`tests/unit/kernel/positive-path-csv-matrix.test.ts`) |
| **3/39 delivered** | ⚠️ Partial export with explicit warning | Verified (`tests/unit/kernel/positive-path-csv-matrix.test.ts`) |
| **0/39 delivered** | ❌ Failed (no file deliverable written/sent) | Verified (`tests/unit/kernel/positive-path-csv-matrix.test.ts`) |
| **0 matching jobs** | ✅ Valid empty result (explicit count = 0) | Verified (`tests/unit/kernel/positive-path-csv-matrix.test.ts`) |
| **Delivery fails** | ❌ Not complete (recoverable failure) | Verified (`tests/unit/kernel/positive-path-csv-matrix.test.ts`) |
| **DB unavailable** | ❌ Not complete (retryable failure) | Verified (`tests/unit/kernel/positive-path-csv-matrix.test.ts`) |
| **Wrong tool selected** | ❌ Blocked by verifier / Recovers to tool | Verified (`tests/unit/kernel/positive-path-csv-matrix.test.ts`) |

---

## 2. Phase 5: Recovery and Objective Ownership
- **In-Band Recovery**: When a step fails, `supervisor.ts` preserves receipts from previous steps and emits diagnostic retry instructions.
- **Crash Recovery**: `mission-resume.ts` inspects Postgres checkpoints on boot. If a mission crashed mid-execution without a completed reply or fold, it resumes via a null-input stream and delivers the final reply or re-raises HITL cards.
- **Idempotency**: All resume paths use deterministic idempotency keys (`agents.action_log`) to prevent re-execution of side effects.

---

## 3. Road to Convergence (P6–P12)
- **P6: Dead-Code Removal**: Remove unreachable subsystems and enforce `orphan-subsystem: 0`.
- **P7: Choice Reduction**: Collapse decision surface (split marketing/creative, consolidate `recall` and `research`).
- **P8: Mechanical CI**: Turn all process rules into CI gates.
- **P9: Founder UX**: High-level natural language control.
- **P10: Adversarial Attacks**: Stress-test edge cases, broken DBs, and failure recovery.
- **P11: Self-Improvement**: Feed verified failure lessons into `turicks-brain`.
- **P12: Convergence**: Canonical 30-task founder benchmark.
