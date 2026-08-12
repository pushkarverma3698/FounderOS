# ADR-015: personal-rag Is Read-Only From Every Agent Tool

**Status:** ACCEPTED (retroactively documented — the boundary was already implemented and enforced in code; this ADR gives it a real citation)
**Date:** 2026-08-11
**Context:** jobhunt / career tooling audit

---

## Decision

No agent tool ever writes to `personal-rag` (Pushkar's personal knowledge base), and no job-application or job-market data is ever cross-posted into it or into `turicks-brain`. `read_cv` and `cv_gaps` only read from it. This is enforced by construction — the tools that touch `personal-rag` do not expose a write path — not by a runtime policy check.

## Context

`personal-rag` holds Pushkar's real CV, career history, and background — first-person source of truth about him. Job-hunt tooling (`screen_job`, `cv_gaps`, CV tailoring) reads it constantly to ground drafts in real facts instead of invented ones. The risk this boundary exists to prevent: a tool that both reads and writes personal-rag could let inferred or LLM-generated content (a tailored bullet point, a market-gap guess) drift back into the source-of-truth record, silently corrupting it over repeated runs. Job-application data (postings, screening verdicts, market gap analysis) is operationally distinct from personal facts and must never be cross-posted into either knowledge base.

## Options Considered

### A: Allow `cv_gaps` to write suggested CV edits back to personal-rag
Rejected — a suggestion is not a fact Pushkar has confirmed; writing it in makes personal-rag a mix of ground truth and AI inference with no way to tell which is which later.

### B (chosen): Read-only, by construction
`read_cv` and `cv_gaps` call only the read surface of `personal-rag` (`mcp__personal-rag__*` read tools). No write tool exists for it in the jobhunt or career department. Edits to Pushkar's real background happen outside the agent, by Pushkar himself, in the source documents personal-rag indexes.

## Current State

| Surface | Access |
|---|---|
| `read_cv` (`src/tools/career.ts`) | read-only |
| `cv_gaps` (`src/tools/jobhunt/gaps.ts`) | read-only |
| `job_applications` table | never cross-posted to personal-rag or turicks-brain |

## References

- `src/tools/career.ts:15,203`
- `src/tools/jobhunt/gaps.ts:8`
- `src/db/schema.ts:1106`
