---
name: Agent task
about: A self-contained task for the Antigravity dispatcher. Do NOT apply agent:ready until every section below is filled in — that label is the explicit intake gate.
title: ""
labels: []
assignees: []
---

<!--
This issue is read by Antigravity with no other context — no conversation history, no assumed
knowledge of why this was filed. Every section must stand on its own. See
docs/antigravity/ISSUE-DRIVEN-CONTRACT.md for how this gets consumed.

Do not apply the `agent:ready` label until this is actually ready. That label is the intake gate —
applying it starts an unattended implementation.
-->

## Goal

<!-- One paragraph. What does "done" mean? -->

## Problem / observed behavior

<!-- What is actually happening. Include exact error text, log lines, or reproduction steps if known. -->

## Expected behavior

<!-- What should happen instead. -->

## Evidence

<!-- Logs, file:line references, links to prior investigation. Claims without evidence get re-verified
     by Antigravity anyway (see the contract's step 4), but evidence here saves a redundant investigation. -->

## Files or subsystem in scope

<!-- Exact paths. "Somewhere in src/agents" is not in scope — narrow it. -->

## Constraints

<!-- Anything that shapes the fix: performance, existing contracts that must not change, etc. -->

## Explicitly forbidden

<!-- Task-specific only. The general rules (no `any`, no mutation, no touching /opt/founderos, never
     merge, never force-push, etc.) already live in docs/antigravity/STANDARDS.md and
     docs/antigravity/ISSUE-DRIVEN-CONTRACT.md — don't restate them here, only what's specific to
     this task (e.g. "do not touch the CSV formatting logic, only the delivery path"). -->

## Verification commands

<!-- The exact command(s) whose raw output proves the fix. E.g. `pnpm test tests/unit/...`,
     `pnpm gate`. If a live/manual check is also required, say so explicitly here and it will be
     flagged for a human-triggered reality test rather than run automatically. -->

## Acceptance criteria

<!-- What the reviewer (Claude/pr-brain) checks before this counts as PASS. Be as concrete as
     possible — "the founder sends X and receives an actual Y" is a much stronger criterion than
     "the feature works." -->
