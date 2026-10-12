---
name: systematic-debugging
description: Methodical root cause analysis for bugs, errors, and unexpected behavior. Follows a structured Root Cause → Hypotheses → Targeted Fixes → Documentation pipeline. Use when debugging is needed — paste error logs, stack traces, or describe unexpected behavior to trigger this skill.
---

# Systematic Debugging

## Overview

Structured debugging: observe → hypothesize → isolate → fix → document. Every step logged so the root cause is understood, not just patched.

---

## Step 1: Observe — Capture Full Context

Before touching code, gather:
1. **Exact error + full stack trace** (not just the last line)
2. **Minimal reproduction steps**
3. **Environment context** — versions, OS, recent changes
4. **Surrounding logs** — lines before + after the error
5. **Expected vs actual behavior**

---

## Step 2: Hypothesize — Ranked Candidate Causes

Generate 3–5 hypotheses ordered by likelihood. For each:
- One-sentence root cause statement
- Mechanism: "X leads to Y because Z"
- Specific code location to check
- Confidence: high / medium / low

**Common root cause categories:**
- State mutation / race condition
- Null/undefined reference
- Type mismatch or coercion
- Off-by-one / boundary condition
- Missing await (async issues)
- Environment/config difference
- Dependency version conflict
- Incorrect external API assumption

---

## Step 3: Isolate — Test Cheapest Hypothesis First

1. **Read the suspect code** before changing it
2. **Add targeted logging** — confirm actual values at the failure point
3. **Minimal reproduction** — strip to smallest failing case
4. **git blame/log** — when did this last work?
5. **Diff against known-good** — what changed?

**Never:** rewrite before understanding, apply multiple fixes at once, jump to "cache issue" without evidence.

---

## Step 4: Fix — Surgical Change

1. Apply the minimal change
2. Grep for similar patterns in the codebase
3. Consider side effects
4. Add a regression test for the exact reproduction case
5. Verify: run the reproduction, confirm it passes

---

## Step 5: Document — Leave It Better

1. Inline comment explaining *why* (not just what)
2. Update MEMORY.md → "critical gotchas" if it's a subtle trap
3. Root cause summary:

```
Root Cause: [what was wrong]
Why: [mechanism / contributing factors]
Fix: [what changed and why]
Prevention: [test added / pattern to avoid]
```

---

## Quick Reference by Error Type

| Error Type | First Check |
|-----------|------------|
| Import / Module Not Found | Installed? Path correct? Circular import? Named vs default export? |
| TypeError | Log `typeof x` + value at call site. Check API boundary shapes |
| Async/Promise | Missing await? Unhandled rejection? Race condition? |
| Database | Connection pool? Transaction committed? Schema mismatch? N+1? |
| Config/Env | Env var exported? Prod vs dev config? Docker vs local? |
| 500 crash | Start from last frame in *your* code, not framework internals |

---

## Output Format

```
## Debug Summary

**Error:** [original error]
**Root Cause:** [confirmed cause]
**Fix Applied:** [file:line — what changed]
**Test Added:** [yes/no, test name]
**MEMORY.md Updated:** [yes/no]
**Similar Patterns Found:** [other locations with same bug, if any]
```
