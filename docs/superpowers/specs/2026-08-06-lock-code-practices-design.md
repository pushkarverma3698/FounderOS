# Design — Locking code practices against drift

**Date:** 2026-08-06 · **Status:** APPROVED by founder · **Milestone:** cross-cutting (serves M0a→M6)

---

## Problem

Four files claim authority over how code is written here — `CLAUDE.md`, `AGENTS.md`,
`.cursorrules`, `docs/antigravity/STANDARDS.md` — and they have already drifted apart. Measured
this session:

1. `.cursorrules` §6 claims git policy is "CI-enforced by `.github/workflows/branch-policy.yml`".
   That workflow was deleted 2026-08-01. The file has been lying for three weeks and nobody noticed.
2. `AGENTS.md` states "~1100 tests". Actual: **2540**. Off by 2.3x.
3. No `GEMINI.md` exists. Antigravity is Gemini-based, and the only thing pointing it at
   STANDARDS.md is `~/.gemini/antigravity/global_skills/delegated-task/SKILL.md` — **outside the
   repository**, unversioned, absent on any other machine.
4. No precedence is stated. When these files disagree, nothing says which wins.

The founder's stated concern: *"as a technical person going forward I might drift from my vision."*

**The binding insight:** a markdown file is not a lock. `STANDARDS.md` caught a real defect an hour
after it was written — but only because a human read it during review. The repo's one mechanism that
has actually held is `scripts/verify-architecture.ts`: fitness functions, a ratchet that only
shrinks, tombstones that hard-fail. Five rules, 254 lines, counts unmoved for a month.

So the work is not "write more rules." It is: **decide which practices become executable rules that
fail CI, and which stay documentation** — because every unenforceable rule dilutes the enforceable
ones.

---

## Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| Lock strength | **Tagged escape hatch** | Founder can always proceed, but every exception lands in the diff, greps in one command, and is counted by the ratchet. Drift becomes a rising number instead of silence. Hard-fail would block a real incident; warn-only is what already failed with `.cursorrules`. |
| Scope | **Receipts-backed rules + repo-wide hygiene** | Three rules each cite a failure that actually happened; two more are zero-cost and lock a currently-clean state. Rejected full STANDARDS.md codification: most of it has no failure behind it and several parts are not mechanically checkable, which would make the escape tag reflexive rather than meaningful. |
| Home | **Existing `verify-architecture.ts`** | Same file, same ratchet, same baseline JSON. No second system. |

---

## Mechanism

Escape hatch reuses the convention already in the file, so there is one form, not two:

```ts
// allow-explicit-any: drizzle returns an untyped row shape at this boundary
const row = result as any;
```

- Format: `// allow-<rule-id>: <reason>` on the offending line **or the line directly above it**
  (matching existing `allow-failopen:` behaviour exactly).
- **A non-empty reason is mandatory.** A bare `// allow-explicit-any:` with nothing after the colon
  does not suppress the violation. This is the difference between an exception and a bypass.
- Tagged lines are excluded from the violation count, so the ratchet measures untagged drift.

---

## The five rules, with measured baselines

| Rule id | Detects | Scope | Baseline |
|---|---|---|---|
| `analyzer-purity` | imports of `src/db/`, `node:fs`, `node:path` | `src/evolution/analyzers/` | **0** (hard zero) |
| `text-reachability` | `.includes(` called on file text | `src/evolution/analyzers/` | **0** (hard zero) |
| `doc-claims-ci` | a `.md` citing `.github/workflows/*.yml` that does not exist | all `*.md` | **1** → fixed → **0** |
| `no-explicit-any` | `: any`, `as any`, `<any>`, `, any>` — **comment lines excluded** | `src/` | **10** (ratchet down) |
| `no-console-log` | `console.log(` / `console.debug(` | `src/` | **0** (hard zero) |

Four of five lock at zero — the strongest position available, since every future violation is then
new and attributable to a specific diff.

### Receipts

- **`text-reachability`** — five wrong answers. Three during the 2026-08-06 hand audit (a doc
  comment merely *mentioning* `src/outreach/graph.ts` made a dead subsystem look alive), then two
  more in AG-001 when the brief specified raw-text matching: `src/outreach/graph.ts` looked tested
  because a test imported `src/kernel/graph.js`, and `src/kernel/worker.ts` looked tested because a
  test mentioned `src/kernel/worker-utils`. Both false negatives — silent by construction.
- **`analyzer-purity`** — the entire M0a sensor design rests on analyzers being pure so the audit
  runs in CI at $0 and is reproducible. Nothing currently prevents the next analyzer from reading a
  file directly.
- **`doc-claims-ci`** — `.cursorrules` §6, above. A doc that tells an agent "CI protects you" when
  it does not is worse than no doc.

### A second measurement that forced a change

`no-explicit-any` first measured **14**. Inspecting the hits, **4 were prose inside doc comments**
("returns false on *any* error", "*any* fatal problem"). A rule that fires on comments is precisely
the noise that trains a reader to reach for the escape hatch reflexively — the failure mode this
design exists to avoid. Detection therefore **skips lines whose trimmed form begins with `//`, `*`,
or `/*`**, and the true baseline is **10**, across 8 files.

### Scope decision that a measurement forced

`doc-claims-ci` was originally scoped to workflow **and** `scripts/` references. Measurement: **17
of 51** doc references to those paths are broken. Sixteen are stale references in historical docs
(`ZERO-BASE-AUDIT.md` probe scripts) or paths relative to a different root (`scripts/produce.mjs`
actually lives under `video-factory/`). Pinning a 16-violation baseline of near-pure noise is
exactly the dilution this design rejects, so the rule is **workflow references only**, where the
count is 1 and the failure mode is dangerous. The 16 stale script references are logged as separate
non-blocking cleanup.

---

## Structural fixes

**Create `GEMINI.md`** in the repository, pointing at STANDARDS.md and the precedence order. This
closes the hole where the Antigravity-side lock lives outside version control.

**State precedence in all four files:**

```
1. Founder instruction in chat                  ← always wins
2. CI fitness rules (verify-architecture.ts)    ← the only BINDING layer
3. docs/antigravity/STANDARDS.md                ← how code is written
4. CLAUDE.md / AGENTS.md / GEMINI.md            ← role-specific operating instructions
5. Everything else                              ← reference
```

**Replace `.cursorrules` with a pointer.** It is three weeks stale, duplicates `AGENTS.md` and
`STANDARDS.md`, and its one unique claim is false. Cursor needs the file to exist; it does not need
to be a fourth source of truth.

**Fix `AGENTS.md`** test count: ~1100 → 2540.

---

## Testing

Each rule is a pure function `(files: Array<{rel, text}>) => RuleResult`, matching the five already
in the file. Per rule: one true positive, one true negative, one proving a tagged line is
suppressed. Plus one test proving a **reason-less** tag does not suppress — that is the test that
keeps the escape hatch honest.

Roughly 16 tests. `governance/architecture-baseline.json` gains five keys.

---

## Delivery

Three Antigravity briefs with **disjoint file sets**, dispatchable in parallel:

| Brief | Files | Depends on |
|---|---|---|
| AG-004 | `scripts/verify-architecture.ts`, `governance/architecture-baseline.json`, `tests/unit/scripts/verify-architecture.test.ts` | nothing |
| AG-005 | `GEMINI.md`, `.cursorrules`, `AGENTS.md`, `CLAUDE.md`, `docs/antigravity/*.md` | nothing |
| AG-006 | `src/evolution/rank.ts`, `src/evolution/report.ts`, `tests/unit/evolution/rank.test.ts` | nothing (M0a output surface) |

No two briefs touch the same file. The one shared surface is the verify command, which reads the
whole tree — so **AG-004's brief pins the expected baselines as literals and instructs the agent to
STOP and report rather than pin a measurement that differs.** That converts a concurrency race into
a loud failure instead of a silently wrong pin.

Not delegated, retained by Claude: the precedence decision, and the M0a scheduler/Telegram wiring
(gateway-adjacent, needs architectural judgement).
