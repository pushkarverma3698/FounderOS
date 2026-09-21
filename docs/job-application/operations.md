# Job Application Operator Operations

## Running the Operator

The system runs autonomously. However, you can manually trigger a dry run to observe the form-filling logic without submitting applications:

```bash
pnpm tsx scripts/dry-run-operator.ts
```

## Logs and State

- View the execution state of an application via `application_tasks.state`.
- **States**: `QUEUED`, `PREPARING`, `READY`, `OPENING`, `FILLING`, `REVIEWING`, `SUBMITTING`, `VERIFYING`, `APPLIED`, `BLOCKED`, `FAILED`, `SKIPPED`.

## Escaping Blockers

When the deterministic executor cannot map a form, or encounters a CAPTCHA, it fails safely into a `BLOCKED` state.
This logs a row in `hitl_approvals` which will ping the Telegram gateway for human review. Once you authorize a bypass or provide the missing context, FounderOS resumes the task where it left off.

## Token Economy

The architecture minimizes LLM usage. Token usage is restricted to cases where `BrowserApplicationExecutor` encounters unexpected DOM states.
**Normal applications consume 0 LLM tokens during execution.** Tailoring of the CV consumes tokens during `PREPARING` via `buildApplicationPacket`.
