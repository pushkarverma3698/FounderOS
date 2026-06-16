# Weekly QA Auditor Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flawed inline-bash `weekly-qa-audit.sh` with a token-frugal 3-stage funnel — deterministic TypeScript harvest+triage (0 Claude tokens) feeding a hard-capped digest to a single Claude reasoning pass that opens a PR a human merges.

**Architecture:** A new repo module `scripts/log-review/` does Stages 1–2 in pure, unit-tested TypeScript: pull prod journalctl JSON + Postgres state → build `Turn[]` keyed by `turnId` → run pure detectors + DB state-checks → emit a bounded `digest.json`. A thin orchestrator shell script runs the digest, hands it to `claude -p` (Stage 3, on the VPS in an isolated `/opt/founderos-qa` workspace), gates the PR on a green build, and notifies the founder via Telegram + a Markdown report. Same engine behind two triggers: weekly cron and on-demand `pnpm logreview`.

**Tech Stack:** Node 22, TypeScript 5.5 (ESM, `.js` import suffix), vitest 2.1.8, `pg` 8.13 (`getPgPool()`), drizzle (`src/db/queries.ts` reused read-only), pino JSON prod logs, `claude -p` CLI, `gh`/GitHub API.

**Spec:** `docs/superpowers/specs/2026-06-15-weekly-qa-auditor-rebuild-design.md`

---

## Conventions (read once)

- All imports use `.js` suffix even for `.ts` (`import { x } from "./types.js"`).
- Env access is bracket notation: `process.env["KEY"]`.
- New code lives under `scripts/log-review/`. Tests live under `tests/unit/log-review/` and `tests/integration/log-review/`.
- Pure modules (`types`, `timeline`, `detectors`, `digest`) import **no** I/O. I/O lives in `sources.ts`, `state-checks.ts`, `harvest.ts`.
- Run a single test file: `pnpm vitest run tests/unit/log-review/<file>.test.ts`.
- Commit after every task. Conventional commits, **no AI attribution** (founder rule).

## File Structure

| File | Responsibility | Pure? |
|------|----------------|-------|
| `scripts/log-review/types.ts` | `Severity`, `SignalType`, `LogLine`, `Turn`, `Anomaly`, `Digest`. | — |
| `scripts/log-review/timeline.ts` | `buildTimeline(lines: LogLine[]): Turn[]` — group pino lines by `turnId`. | Yes |
| `scripts/log-review/detectors.ts` | One pure fn per hard signal → `Anomaly \| null`; `runDetectors(turns): Anomaly[]`. | Yes |
| `scripts/log-review/digest.ts` | `buildDigest(turns, anomalies, stateFindings, opts): Digest` — cap, healthy-collapse, content hash. | Yes |
| `scripts/log-review/sources.ts` | Pull journalctl JSON + parse into `LogLine[]`. | No (I/O) |
| `scripts/log-review/state-checks.ts` | DB-state assertions reusing `src/db/queries.ts` + read-only count helpers. | No (DB) |
| `scripts/log-review/harvest.ts` | CLI: sources→timeline→detectors+state→digest; writes `digest.json` + summary. Zero Claude tokens. | No |
| `scripts/log-review/stage3-prompt.md` | The Claude Stage-3 prompt (regression-test-first, hallucination-judging framing). | — |
| `scripts/weekly-qa-audit.sh` | Rewritten thin orchestrator (replaces the VPS inline version). | — |
| `docs/decisions/026-weekly-qa-auditor.md` | ADR for the rebuild. | — |
| `docs/runbooks/qa-workspace-setup.md` | VPS `/opt/founderos-qa` provisioning + cron runbook. | — |

Test fixtures: `tests/fixtures/log-review/` (committed prod-shaped journalctl JSON).

---

## Task 0: Interim safety — disable the flawed cron on the VPS

**Why first:** the existing `weekly-qa-audit.sh` cron fires Sun 2026-06-21 with 3 P0 flaws. Disable it before anything else so it cannot run unsupervised during the rebuild.

- [ ] **Step 1: Inspect current crontab on the VPS**

```bash
ssh -i ~/.ssh/founderos_deploy founderos@95.217.162.12 'crontab -l'
```
Expected: a line like `30 17 * * 0 /opt/founderos/scripts/weekly-qa-audit.sh ...`

- [ ] **Step 2: Comment out the weekly-qa line (idempotent)**

```bash
ssh -i ~/.ssh/founderos_deploy founderos@95.217.162.12 \
  "crontab -l | sed 's|^\([^#].*weekly-qa-audit.sh\)|# DISABLED pending rebuild 2026-06-15: \1|' | crontab -"
```

- [ ] **Step 3: Verify it is commented**

```bash
ssh -i ~/.ssh/founderos_deploy founderos@95.217.162.12 'crontab -l | grep weekly-qa'
```
Expected: the line is present but prefixed with `# DISABLED pending rebuild`.

No commit (remote ops only). Record the action in the PR description later.

---

## Task 1: `types.ts` — shared shapes

**Files:**
- Create: `scripts/log-review/types.ts`

- [ ] **Step 1: Write the types**

```typescript
// scripts/log-review/types.ts
// Shared shapes for the log-review funnel. No I/O, no logic.

export type Severity = "high" | "medium" | "low";

export type SignalType =
  | "error" // level:50, 503/400/409, crash
  | "wedge" // recursion / budget abort, wedged thread
  | "send_without_audit" // external send with no action_log row
  | "double_exec" // same idempotency key executed twice
  | "silent_fail" // "Done." reply with no supporting row
  | "reset_churn" // repeated /reset or repeated identical user message
  | "latency_cost" // turn.out ms or usd spike
  | "empty_store" // RAG / knowledge store has zero rows
  | "dead_tool_key" // integration key invalid / tool outage
  | "hallucination_candidate"; // borderline — Claude judges in Stage 3

/** One parsed pino JSON log line from prod journalctl. */
export interface LogLine {
  level: number; // pino numeric level (50=error, 40=warn, 30=info)
  time: number; // epoch ms
  seam?: string; // trace seam, e.g. "turn.out"
  turnId?: string;
  msg?: string;
  module?: string;
  data?: Record<string, unknown>;
  raw: string; // original line, for evidence
  [k: string]: unknown;
}

/** All log lines belonging to one turn, plus derived facts. */
export interface Turn {
  turnId: string;
  chatId?: string;
  startMs: number;
  endMs: number;
  lines: LogLine[];
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
  durationMs?: number; // from turn.out ms
  toolErrors: number;
  hadError: boolean; // any level>=50 line
  reply?: string; // replyPreview if present
}

/** A deterministic finding the funnel can prove. */
export interface Anomaly {
  type: SignalType;
  severity: Severity;
  turnId?: string;
  summary: string; // one line, human-readable
  evidence: string[]; // raw log lines / counts backing the claim
}

/** A DB-state finding (rule #22 — verify state, not schema). */
export interface StateFinding {
  type: SignalType;
  severity: Severity;
  summary: string;
  evidence: string[];
}

/** The bounded artifact Claude reads in Stage 3. */
export interface Digest {
  generatedAt: string; // ISO
  windowDays: number;
  contentHash: string; // hash of the issue set → stable branch name
  counts: {
    turns: number;
    errors: number;
    warns: number;
    healthyTurns: number;
  };
  hardAnomalies: Anomaly[];
  stateFindings: StateFinding[];
  borderlineTurns: Turn[]; // capped candidate set for Claude to judge
  truncated: boolean; // true if candidates exceeded the cap
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm lint`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add scripts/log-review/types.ts
git commit -m "feat(log-review): shared types for the QA funnel"
```

---

## Task 2: `timeline.ts` — group log lines into turns

**Files:**
- Create: `scripts/log-review/timeline.ts`
- Test: `tests/unit/log-review/timeline.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/log-review/timeline.test.ts
import { describe, it, expect } from "vitest";
import { buildTimeline } from "../../../scripts/log-review/timeline.js";
import type { LogLine } from "../../../scripts/log-review/types.js";

const line = (o: Partial<LogLine>): LogLine => ({
  level: 30,
  time: 0,
  raw: JSON.stringify(o),
  ...o,
});

describe("buildTimeline", () => {
  it("groups lines by turnId and orders by start time", () => {
    const lines: LogLine[] = [
      line({ turnId: "B", time: 200, seam: "turn.in" }),
      line({ turnId: "A", time: 100, seam: "turn.in" }),
      line({ turnId: "A", time: 150, seam: "turn.out", data: { usd: 0.01, ms: 500 } }),
    ];
    const turns = buildTimeline(lines);
    expect(turns.map((t) => t.turnId)).toEqual(["A", "B"]);
    expect(turns[0]!.usd).toBe(0.01);
    expect(turns[0]!.durationMs).toBe(500);
  });

  it("derives token + tool-error facts from turn.out", () => {
    const turns = buildTimeline([
      line({
        turnId: "A",
        time: 1,
        seam: "turn.out",
        data: { inputTokens: 1200, outputTokens: 300, usd: 0.02, toolErrors: 2 },
      }),
    ]);
    expect(turns[0]!.inputTokens).toBe(1200);
    expect(turns[0]!.outputTokens).toBe(300);
    expect(turns[0]!.toolErrors).toBe(2);
  });

  it("flags hadError when any line is level>=50", () => {
    const turns = buildTimeline([
      line({ turnId: "A", time: 1, level: 50, msg: "boom" }),
    ]);
    expect(turns[0]!.hadError).toBe(true);
  });

  it("drops lines with no turnId into no synthetic turn", () => {
    const turns = buildTimeline([line({ time: 1, level: 50, msg: "orphan" })]);
    expect(turns).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run tests/unit/log-review/timeline.test.ts`
Expected: FAIL — `buildTimeline` not found.

- [ ] **Step 3: Implement**

```typescript
// scripts/log-review/timeline.ts
import type { LogLine, Turn } from "./types.js";

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Group pino log lines by turnId into ordered Turn[]. Pure. */
export function buildTimeline(lines: LogLine[]): Turn[] {
  const byTurn = new Map<string, Turn>();

  for (const line of lines) {
    const id = line.turnId;
    if (!id) continue; // orphan lines never create a synthetic turn

    let turn = byTurn.get(id);
    if (!turn) {
      turn = {
        turnId: id,
        startMs: line.time,
        endMs: line.time,
        lines: [],
        toolErrors: 0,
        hadError: false,
      };
      byTurn.set(id, turn);
    }

    turn.lines.push(line);
    turn.startMs = Math.min(turn.startMs, line.time);
    turn.endMs = Math.max(turn.endMs, line.time);
    if (line.level >= 50) turn.hadError = true;
    if (typeof line["chatId"] === "string") turn.chatId = line["chatId"];

    if (line.seam === "turn.out" && line.data) {
      turn.inputTokens = num(line.data["inputTokens"]) ?? turn.inputTokens;
      turn.outputTokens = num(line.data["outputTokens"]) ?? turn.outputTokens;
      turn.usd = num(line.data["usd"]) ?? turn.usd;
      turn.durationMs = num(line.data["ms"]) ?? turn.durationMs;
      const te = num(line.data["toolErrors"]);
      if (te !== undefined) turn.toolErrors = te;
    }
    const preview = line.data?.["replyPreview"];
    if (typeof preview === "string") turn.reply = preview;
  }

  return [...byTurn.values()].sort((a, b) => a.startMs - b.startMs);
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm vitest run tests/unit/log-review/timeline.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/log-review/timeline.ts tests/unit/log-review/timeline.test.ts
git commit -m "feat(log-review): buildTimeline groups log lines into turns"
```

---

## Task 3: `detectors.ts` — pure detectors for hard signals

Each detector proves a fault from the turn's own lines. **No hallucination keyword grep** — fabrication is judged by Claude in Stage 3 (P0-2 fix). Detectors only emit `hallucination_candidate` to *route a turn into the borderline set*, never to assert it.

**Files:**
- Create: `scripts/log-review/detectors.ts`
- Test: `tests/unit/log-review/detectors.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/log-review/detectors.test.ts
import { describe, it, expect } from "vitest";
import { runDetectors } from "../../../scripts/log-review/detectors.js";
import type { Turn } from "../../../scripts/log-review/types.js";

const base = (o: Partial<Turn>): Turn => ({
  turnId: "T",
  startMs: 0,
  endMs: 1,
  lines: [],
  toolErrors: 0,
  hadError: false,
  ...o,
});

describe("runDetectors", () => {
  it("flags an errored turn", () => {
    const a = runDetectors([
      base({ hadError: true, lines: [{ level: 50, time: 1, msg: "crash", raw: "crash" }] }),
    ]);
    expect(a.some((x) => x.type === "error")).toBe(true);
  });

  it("flags a wedge/recursion abort", () => {
    const a = runDetectors([
      base({ lines: [{ level: 40, time: 1, seam: "wedge.recovered", raw: "wedge", msg: "recursion limit" }] }),
    ]);
    expect(a.some((x) => x.type === "wedge")).toBe(true);
  });

  it("flags latency spike over threshold", () => {
    const a = runDetectors([base({ durationMs: 45000 })]);
    expect(a.some((x) => x.type === "latency_cost")).toBe(true);
  });

  it("does NOT flag an honest refusal as a problem (P0-2)", () => {
    const a = runDetectors([
      base({ reply: "Sorry, I don't have that information.", durationMs: 800 }),
    ]);
    // an honest refusal alone is healthy — no hard anomaly
    expect(a.filter((x) => x.severity === "high")).toHaveLength(0);
  });

  it("routes a confident-no-tool-call turn into the borderline set", () => {
    const a = runDetectors([
      base({
        reply: "Turicks targets B2B SaaS founders in seed stage.",
        lines: [{ level: 30, time: 1, seam: "route.decided", raw: "route", data: { dept: "research" } }],
        // no tool.result / no rag hit in lines
      }),
    ]);
    expect(a.some((x) => x.type === "hallucination_candidate")).toBe(true);
  });

  it("returns nothing for a clean turn with a tool call", () => {
    const a = runDetectors([
      base({
        reply: "Found 3 results.",
        durationMs: 900,
        lines: [{ level: 30, time: 1, seam: "tool.result", raw: "ok" }],
      }),
    ]);
    expect(a).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run tests/unit/log-review/detectors.test.ts`
Expected: FAIL — `runDetectors` not found.

- [ ] **Step 3: Implement**

```typescript
// scripts/log-review/detectors.ts
import type { Anomaly, Turn } from "./types.js";

const LATENCY_MS = 30_000; // turn.out ms over this = slow
const COST_USD = 0.05; // per-turn cost over this = spike

const hasSeam = (t: Turn, seam: string): boolean => t.lines.some((l) => l.seam === seam);
const lineText = (t: Turn): string =>
  t.lines.map((l) => `${l.msg ?? ""} ${l.raw}`).join(" ").toLowerCase();

/** level>=50 anywhere in the turn. */
function detectError(t: Turn): Anomaly | null {
  if (!t.hadError && t.toolErrors === 0) return null;
  const evidence = t.lines.filter((l) => l.level >= 50).map((l) => l.raw).slice(0, 5);
  return {
    type: "error",
    severity: t.hadError ? "high" : "medium",
    turnId: t.turnId,
    summary: `Turn ${t.turnId} hit ${t.hadError ? "an error" : `${t.toolErrors} tool error(s)`}.`,
    evidence: evidence.length ? evidence : [`toolErrors=${t.toolErrors}`],
  };
}

/** recursion/budget abort or wedge recovery. */
function detectWedge(t: Turn): Anomaly | null {
  const text = lineText(t);
  const wedged =
    hasSeam(t, "wedge.recovered") ||
    text.includes("recursion limit") ||
    text.includes("budget") && text.includes("abort");
  if (!wedged) return null;
  return {
    type: "wedge",
    severity: "high",
    turnId: t.turnId,
    summary: `Turn ${t.turnId} hit a recursion/budget abort or wedge recovery.`,
    evidence: t.lines.filter((l) => /wedge|recursion|abort/i.test(l.raw)).map((l) => l.raw).slice(0, 5),
  };
}

/** latency or cost spike from turn.out. */
function detectLatencyCost(t: Turn): Anomaly | null {
  const slow = (t.durationMs ?? 0) > LATENCY_MS;
  const pricey = (t.usd ?? 0) > COST_USD;
  if (!slow && !pricey) return null;
  return {
    type: "latency_cost",
    severity: "medium",
    turnId: t.turnId,
    summary: `Turn ${t.turnId} ${slow ? `took ${t.durationMs}ms` : ""}${slow && pricey ? " and " : ""}${pricey ? `cost $${t.usd}` : ""}.`,
    evidence: [`ms=${t.durationMs ?? "?"} usd=${t.usd ?? "?"}`],
  };
}

/**
 * Borderline router (NOT an assertion). A confident-looking reply with no
 * supporting tool.result / rag hit in the turn is a fabrication CANDIDATE —
 * Claude judges it in Stage 3. Honest refusals are excluded.
 */
function detectHallucinationCandidate(t: Turn): Anomaly | null {
  const reply = (t.reply ?? "").trim();
  if (!reply) return null;
  const refusal = /\b(i don't have|i do not have|cannot|can't|no information|not able|don't know)\b/i.test(reply);
  if (refusal) return null; // honest refusal = good behaviour, never a candidate
  const grounded = hasSeam(t, "tool.result") || lineText(t).includes("rag") || lineText(t).includes("search_knowledge");
  if (grounded) return null;
  // confident, substantive, ungrounded → candidate only
  if (reply.length < 40) return null;
  return {
    type: "hallucination_candidate",
    severity: "low",
    turnId: t.turnId,
    summary: `Turn ${t.turnId}: confident reply with no tool/RAG support — Claude to judge.`,
    evidence: [reply.slice(0, 200)],
  };
}

const DETECTORS = [detectError, detectWedge, detectLatencyCost, detectHallucinationCandidate];

/** Run every detector over every turn. Pure. */
export function runDetectors(turns: Turn[]): Anomaly[] {
  const out: Anomaly[] = [];
  for (const t of turns) {
    for (const d of DETECTORS) {
      const a = d(t);
      if (a) out.push(a);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm vitest run tests/unit/log-review/detectors.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/log-review/detectors.ts tests/unit/log-review/detectors.test.ts
git commit -m "feat(log-review): pure detectors; hallucination is candidate-only (P0-2)"
```

---

## Task 4: `digest.ts` — bounded assembly + content hash

**Files:**
- Create: `scripts/log-review/digest.ts`
- Test: `tests/unit/log-review/digest.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/log-review/digest.test.ts
import { describe, it, expect } from "vitest";
import { buildDigest, MAX_DIGEST_TURNS } from "../../../scripts/log-review/digest.js";
import type { Turn, Anomaly } from "../../../scripts/log-review/types.js";

const turn = (id: string): Turn => ({
  turnId: id, startMs: 0, endMs: 1, lines: [], toolErrors: 0, hadError: false,
});
const cand = (id: string): Anomaly => ({
  type: "hallucination_candidate", severity: "low", turnId: id,
  summary: "c", evidence: ["e"],
});

describe("buildDigest", () => {
  it("collapses healthy turns into counts and caps borderline turns", () => {
    const turns = Array.from({ length: MAX_DIGEST_TURNS + 5 }, (_, i) => turn(`T${i}`));
    const anomalies = turns.map((t) => cand(t.turnId));
    const d = buildDigest(turns, anomalies, [], { windowDays: 7 });
    expect(d.borderlineTurns.length).toBe(MAX_DIGEST_TURNS);
    expect(d.truncated).toBe(true);
    expect(d.counts.turns).toBe(MAX_DIGEST_TURNS + 5);
  });

  it("produces a stable content hash for the same issue set", () => {
    const turns = [turn("A")];
    const anomalies: Anomaly[] = [
      { type: "error", severity: "high", turnId: "A", summary: "x", evidence: ["e"] },
    ];
    const a = buildDigest(turns, anomalies, [], { windowDays: 7 });
    const b = buildDigest(turns, anomalies, [], { windowDays: 7 });
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).toMatch(/^[a-f0-9]{12}$/);
  });

  it("hash changes when the issue set changes", () => {
    const turns = [turn("A")];
    const a = buildDigest(turns, [{ type: "error", severity: "high", turnId: "A", summary: "x", evidence: [] }], [], { windowDays: 7 });
    const b = buildDigest(turns, [{ type: "wedge", severity: "high", turnId: "A", summary: "y", evidence: [] }], [], { windowDays: 7 });
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run tests/unit/log-review/digest.test.ts`
Expected: FAIL — `buildDigest` not found.

- [ ] **Step 3: Implement**

```typescript
// scripts/log-review/digest.ts
import { createHash } from "node:crypto";
import type { Anomaly, Digest, StateFinding, Turn } from "./types.js";

export const MAX_DIGEST_TURNS = 25; // hard cap on borderline turns Claude reads

/** Hard anomalies are the proven faults; candidates only route turns. */
function isHard(a: Anomaly): boolean {
  return a.type !== "hallucination_candidate";
}

/** Stable 12-char hash of the issue set → deterministic branch naming. */
function hashIssues(hard: Anomaly[], state: StateFinding[]): string {
  const key = [
    ...hard.map((a) => `${a.type}:${a.turnId ?? ""}`),
    ...state.map((s) => `${s.type}`),
  ].sort().join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

export function buildDigest(
  turns: Turn[],
  anomalies: Anomaly[],
  stateFindings: StateFinding[],
  opts: { windowDays: number },
): Digest {
  const hardAnomalies = anomalies.filter(isHard);
  const candidates = anomalies.filter((a) => !isHard(a));

  const candidateIds = new Set(candidates.map((c) => c.turnId));
  const borderlineAll = turns.filter((t) => candidateIds.has(t.turnId));
  const borderlineTurns = borderlineAll.slice(0, MAX_DIGEST_TURNS);

  const errors = turns.filter((t) => t.hadError).length;
  const warns = turns.filter((t) => t.lines.some((l) => l.level === 40)).length;
  const flaggedIds = new Set([...hardAnomalies, ...candidates].map((a) => a.turnId));
  const healthyTurns = turns.filter((t) => !flaggedIds.has(t.turnId)).length;

  return {
    generatedAt: new Date().toISOString(),
    windowDays: opts.windowDays,
    contentHash: hashIssues(hardAnomalies, stateFindings),
    counts: { turns: turns.length, errors, warns, healthyTurns },
    hardAnomalies,
    stateFindings,
    borderlineTurns,
    truncated: borderlineAll.length > MAX_DIGEST_TURNS,
  };
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm vitest run tests/unit/log-review/digest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/log-review/digest.ts tests/unit/log-review/digest.test.ts
git commit -m "feat(log-review): bounded digest with stable content-hash branch key"
```

---

## Task 5: `sources.ts` — parse journalctl JSON into `LogLine[]`

I/O-thin: read journalctl output from stdin or a file path, parse each JSON line into a `LogLine`. (The shell pulls journalctl; this module parses — keeps it testable.)

**Files:**
- Create: `scripts/log-review/sources.ts`
- Test: `tests/unit/log-review/sources.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/log-review/sources.test.ts
import { describe, it, expect } from "vitest";
import { parseLogLines } from "../../../scripts/log-review/sources.js";

describe("parseLogLines", () => {
  it("parses pino JSON lines and tolerates non-JSON noise", () => {
    const raw = [
      `{"level":30,"time":100,"seam":"turn.in","turnId":"A","msg":"in"}`,
      `-- systemd noise line --`,
      `{"level":50,"time":200,"turnId":"A","msg":"boom"}`,
    ].join("\n");
    const lines = parseLogLines(raw);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.turnId).toBe("A");
    expect(lines[1]!.level).toBe(50);
    expect(lines[0]!.raw).toContain("turn.in");
  });

  it("nests structured fields under data when present", () => {
    const raw = `{"level":30,"time":1,"seam":"turn.out","turnId":"A","inputTokens":50,"usd":0.01}`;
    const [line] = parseLogLines(raw);
    // top-level pino fields stay accessible; harvester reads turn.out via data OR top-level
    expect(line!.seam).toBe("turn.out");
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run tests/unit/log-review/sources.test.ts`
Expected: FAIL — `parseLogLines` not found.

- [ ] **Step 3: Implement**

```typescript
// scripts/log-review/sources.ts
import { readFileSync } from "node:fs";
import type { LogLine } from "./types.js";

/**
 * Parse raw journalctl output (one pino JSON object per line) into LogLine[].
 * Non-JSON lines (systemd banners) are skipped. Pino emits trace event fields
 * (seam/turnId) at top level and the event `data` payload may be top-level too;
 * we expose both `data` (if present) and the original top-level via spread.
 */
export function parseLogLines(raw: string): LogLine[] {
  const out: LogLine[] = [];
  for (const ln of raw.split("\n")) {
    const s = ln.trim();
    if (!s.startsWith("{")) continue;
    try {
      const o = JSON.parse(s) as Record<string, unknown>;
      const line: LogLine = {
        level: typeof o["level"] === "number" ? (o["level"] as number) : 30,
        time: typeof o["time"] === "number" ? (o["time"] as number) : 0,
        raw: s,
        ...o,
      };
      // If trace data was logged flat (no `data` wrapper), synthesize it so
      // timeline.ts can read turn.out metrics uniformly.
      if (line.seam && line.data === undefined) {
        line.data = o;
      }
      out.push(line);
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/** Read + parse a journalctl dump file. */
export function loadLogFile(path: string): LogLine[] {
  return parseLogLines(readFileSync(path, "utf8"));
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm vitest run tests/unit/log-review/sources.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/log-review/sources.ts tests/unit/log-review/sources.test.ts
git commit -m "feat(log-review): parse journalctl pino JSON into LogLine[]"
```

---

## Task 6: `state-checks.ts` — verify prod DB STATE (rule #22)

Reuses `src/db/queries.ts` where possible; adds **read-only** count helpers via `getPgPool()` for what's missing (RAG row+embedding counts, sends-without-audit). No writes.

**Files:**
- Create: `scripts/log-review/state-checks.ts`
- Test: `tests/integration/log-review/state-checks.test.ts` (DB-gated)

- [ ] **Step 1: Confirm the RAG table name + reuse points**

Run: `grep -nE "turicks_brain|personal_rag|knowledge_entries|embedding" src/db/schema.ts | head`
Expected: confirms the vector table name(s). Use the actual name in the query below; if it differs from `turicks_brain`, adjust the SQL string.

- [ ] **Step 2: Write the failing integration test**

```typescript
// tests/integration/log-review/state-checks.test.ts
import { describe, it, expect } from "vitest";
import { runStateChecks } from "../../../scripts/log-review/state-checks.js";

// DB-gated: only runs when a database is reachable.
const HAS_DB = !!process.env["DATABASE_URL"];

describe.skipIf(!HAS_DB)("runStateChecks", () => {
  it("returns StateFinding[] and never throws", async () => {
    const findings = await runStateChecks("turicks");
    expect(Array.isArray(findings)).toBe(true);
    for (const f of findings) {
      expect(typeof f.summary).toBe("string");
      expect(["high", "medium", "low"]).toContain(f.severity);
    }
  });
});
```

- [ ] **Step 3: Run it — expect FAIL (or skip if no DB)**

Run: `pnpm vitest run tests/integration/log-review/state-checks.test.ts`
Expected: FAIL — `runStateChecks` not found (or `skipped` if no `DATABASE_URL`).

- [ ] **Step 4: Implement**

```typescript
// scripts/log-review/state-checks.ts
import { getPgPool } from "../../src/db/client.js";
import type { StateFinding } from "./types.js";

/** count(*) helper — read-only, never throws (errors become a finding). */
async function count(sql: string): Promise<number | null> {
  try {
    const res = await getPgPool().query(sql);
    return Number(res.rows[0]?.["n"] ?? 0);
  } catch {
    return null;
  }
}

/**
 * Verify prod DATA state, not schema (rule #22). The canonical 2026-06-15
 * outage was an EMPTY-but-present RAG store → confident fabrication. Names the
 * REAL failing component in each finding.
 */
export async function runStateChecks(tenant: string): Promise<StateFinding[]> {
  const findings: StateFinding[] = [];

  // 1. RAG store populated? empty-but-present is a silent fabrication source.
  const ragRows = await count(`SELECT count(*)::int AS n FROM turicks_brain`);
  if (ragRows === 0) {
    findings.push({
      type: "empty_store",
      severity: "high",
      summary: "turicks_brain (RAG) has 0 rows — Postgres/pgvector empty, run `pnpm brain:sync`.",
      evidence: ["SELECT count(*) FROM turicks_brain → 0"],
    });
  } else if (ragRows === null) {
    findings.push({
      type: "empty_store",
      severity: "high",
      summary: "turicks_brain count query FAILED — Postgres/pgvector unreachable or table missing.",
      evidence: ["count(*) FROM turicks_brain threw"],
    });
  }

  // 2. External sends without an audit row (idempotency/audit integrity).
  const orphanSends = await count(`
    SELECT count(*)::int AS n
    FROM dept_signals s
    WHERE s.event_type IN ('email_sent','linkedin_post','demo_ready')
      AND NOT EXISTS (
        SELECT 1 FROM action_log a WHERE a.idempotency_key = s.idempotency_key
      )`);
  if (orphanSends && orphanSends > 0) {
    findings.push({
      type: "send_without_audit",
      severity: "high",
      summary: `${orphanSends} external send signal(s) have no action_log row — audit integrity gap.`,
      evidence: [`orphan sends = ${orphanSends}`],
    });
  }

  // 3. Orphaned HITL approvals stuck pending far past the sweep window.
  const stuckHitl = await count(`
    SELECT count(*)::int AS n FROM hitl_approvals
    WHERE status = 'pending' AND created_at < now() - interval '24 hours'`);
  if (stuckHitl && stuckHitl > 0) {
    findings.push({
      type: "send_without_audit",
      severity: "medium",
      summary: `${stuckHitl} HITL approval(s) pending > 24h — sweeper or resume path may be wedged.`,
      evidence: [`stuck pending = ${stuckHitl}`],
    });
  }

  return findings;
}
```

> Note: if Step 1 showed the RAG table is named differently (e.g. `knowledge_entries` with an `embedding` column, or `personal_rag`), replace `turicks_brain` in queries 1 with the real name and add a second check for the embedding column being non-null: `SELECT count(*) AS n FROM <table> WHERE embedding IS NOT NULL`.

- [ ] **Step 5: Run — expect PASS (or skip)**

Run: `pnpm vitest run tests/integration/log-review/state-checks.test.ts`
Expected: PASS or skipped (no DB).

- [ ] **Step 6: Commit**

```bash
git add scripts/log-review/state-checks.ts tests/integration/log-review/state-checks.test.ts
git commit -m "feat(log-review): DB state-checks (empty RAG, orphan sends, stuck HITL) — rule #22"
```

---

## Task 7: capture a real prod fixture + lock detector field names

Removes the P2 fragility: detectors are tested against **real** journalctl JSON, not invented shapes.

**Files:**
- Create: `tests/fixtures/log-review/prod-sample.jsonl`
- Create: `tests/unit/log-review/fixture.test.ts`

- [ ] **Step 1: Pull a real, scrubbed prod log sample from the VPS**

```bash
ssh -i ~/.ssh/founderos_deploy founderos@95.217.162.12 \
  'journalctl -u founderos --since "3 days ago" -o cat --no-pager | grep -E "\"seam\"|\"level\":(4|5)0" | tail -200' \
  > tests/fixtures/log-review/prod-sample.jsonl
```
Then **manually scrub** any emails/tokens/PII from the file before committing (open it, redact). If a line has secrets, delete the line.

- [ ] **Step 2: Write a test that runs the real pipeline over the fixture**

```typescript
// tests/unit/log-review/fixture.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseLogLines } from "../../../scripts/log-review/sources.js";
import { buildTimeline } from "../../../scripts/log-review/timeline.js";
import { runDetectors } from "../../../scripts/log-review/detectors.js";
import { buildDigest } from "../../../scripts/log-review/digest.js";

describe("real prod fixture", () => {
  const raw = readFileSync("tests/fixtures/log-review/prod-sample.jsonl", "utf8");

  it("parses, builds turns, detects, and produces a bounded digest", () => {
    const lines = parseLogLines(raw);
    expect(lines.length).toBeGreaterThan(0); // proves field names match reality
    const turns = buildTimeline(lines);
    const anomalies = runDetectors(turns);
    const digest = buildDigest(turns, anomalies, [], { windowDays: 3 });
    expect(digest.counts.turns).toBe(turns.length);
    expect(digest.borderlineTurns.length).toBeLessThanOrEqual(25);
  });

  it("every parsed turn.out line yields token metrics (field-name guard)", () => {
    const lines = parseLogLines(raw);
    const turnOut = lines.filter((l) => l.seam === "turn.out");
    if (turnOut.length === 0) return; // fixture window may have none
    const turns = buildTimeline(lines);
    const withMetrics = turns.filter((t) => t.usd !== undefined || t.inputTokens !== undefined);
    expect(withMetrics.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run — expect PASS**

Run: `pnpm vitest run tests/unit/log-review/fixture.test.ts`
Expected: PASS. If `lines.length` is 0, the field names differ — inspect the fixture and fix `parseLogLines`/`timeline` before continuing.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/log-review/prod-sample.jsonl tests/unit/log-review/fixture.test.ts
git commit -m "test(log-review): real prod fixture locks seam field names (P2 fix)"
```

---

## Task 8: `harvest.ts` — the zero-token CLI (Stages 1–2)

Orchestrates parse→timeline→detectors+state→digest, writes `digest.json` + a plaintext summary. **Never calls Claude.**

**Files:**
- Create: `scripts/log-review/harvest.ts`
- Test: `tests/unit/log-review/harvest.test.ts`

- [ ] **Step 1: Write the failing test (pure assembly fn)**

```typescript
// tests/unit/log-review/harvest.test.ts
import { describe, it, expect } from "vitest";
import { assembleDigest, renderSummary } from "../../../scripts/log-review/harvest.js";

describe("assembleDigest", () => {
  it("builds a digest from raw log text + state findings", async () => {
    const raw = [
      `{"level":50,"time":1,"turnId":"A","msg":"crash"}`,
      `{"level":30,"time":2,"turnId":"A","seam":"turn.out","inputTokens":100,"usd":0.01,"ms":500}`,
    ].join("\n");
    const digest = assembleDigest(raw, [], 7);
    expect(digest.counts.turns).toBe(1);
    expect(digest.hardAnomalies.some((a) => a.type === "error")).toBe(true);
  });

  it("renders a plaintext summary with counts", () => {
    const raw = `{"level":30,"time":1,"turnId":"A","seam":"turn.out","usd":0.01,"ms":100}`;
    const digest = assembleDigest(raw, [], 7);
    const text = renderSummary(digest);
    expect(text).toContain("turns");
    expect(text).toMatch(/hard anomalies/i);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `pnpm vitest run tests/unit/log-review/harvest.test.ts`
Expected: FAIL — `assembleDigest` not found.

- [ ] **Step 3: Implement**

```typescript
// scripts/log-review/harvest.ts
import { writeFileSync } from "node:fs";
import { parseLogLines } from "./sources.js";
import { buildTimeline } from "./timeline.js";
import { runDetectors } from "./detectors.js";
import { buildDigest } from "./digest.js";
import { runStateChecks } from "./state-checks.js";
import type { Digest, StateFinding } from "./types.js";

/** Pure: raw log text + state findings → Digest. */
export function assembleDigest(rawLog: string, state: StateFinding[], windowDays: number): Digest {
  const lines = parseLogLines(rawLog);
  const turns = buildTimeline(lines);
  const anomalies = runDetectors(turns);
  return buildDigest(turns, anomalies, state, { windowDays });
}

/** Human-readable summary for the Telegram notify + report header. */
export function renderSummary(d: Digest): string {
  const lines = [
    `Prod QA digest — ${d.generatedAt} (last ${d.windowDays}d)`,
    `turns=${d.counts.turns} healthy=${d.counts.healthyTurns} errors=${d.counts.errors} warns=${d.counts.warns}`,
    ``,
    `Hard anomalies (${d.hardAnomalies.length}):`,
    ...d.hardAnomalies.map((a) => `  • [${a.severity}] ${a.summary}`),
    ``,
    `State findings (${d.stateFindings.length}):`,
    ...d.stateFindings.map((s) => `  • [${s.severity}] ${s.summary}`),
    ``,
    `Borderline turns for Claude to judge: ${d.borderlineTurns.length}${d.truncated ? " (capped)" : ""}`,
  ];
  return lines.join("\n");
}

/** CLI entry: reads journalctl from stdin, writes digest.json + summary.txt. */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const windowDays = Number(args.find((a) => a.startsWith("--days="))?.split("=")[1] ?? 7);
  const outPath = args.find((a) => a.startsWith("--out="))?.split("=")[1] ?? "digest.json";
  const tenant = args.find((a) => a.startsWith("--tenant="))?.split("=")[1] ?? "turicks";

  const rawLog = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.on("data", (c) => (buf += c));
    process.stdin.on("end", () => resolve(buf));
  });

  let state: StateFinding[] = [];
  try {
    state = await runStateChecks(tenant);
  } catch (err) {
    // fail loud in the summary, never silently drop state checks
    state = [{
      type: "empty_store", severity: "high",
      summary: `state-checks FAILED to run: ${(err as Error).message}`,
      evidence: [String(err)],
    }];
  }

  const digest = assembleDigest(rawLog, state, windowDays);
  writeFileSync(outPath, JSON.stringify(digest, null, 2));
  writeFileSync(outPath.replace(/\.json$/, ".summary.txt"), renderSummary(digest));
  process.stdout.write(renderSummary(digest) + "\n");
}

// Run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `pnpm vitest run tests/unit/log-review/harvest.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the `logreview` script to package.json**

In `package.json` `scripts`, add:
```json
"logreview": "node --env-file=.env --import tsx/esm scripts/log-review/harvest.ts"
```

- [ ] **Step 6: Commit**

```bash
git add scripts/log-review/harvest.ts tests/unit/log-review/harvest.test.ts package.json
git commit -m "feat(log-review): zero-token harvest CLI + pnpm logreview"
```

---

## Task 9: `stage3-prompt.md` — the Claude reasoning prompt

**Files:**
- Create: `scripts/log-review/stage3-prompt.md`

- [ ] **Step 1: Write the prompt**

```markdown
<!-- scripts/log-review/stage3-prompt.md -->
You are the FounderOS production QA auditor. You receive a bounded JSON digest of
one week of production reality (digest.json) — NEVER raw logs. Your job: confirm
real issues, root-cause them, and propose a minimal, regression-tested fix as a PR
for a human to merge.

## Rules (non-negotiable)
1. **Hallucination judging (the core task).** For each `borderlineTurns` entry: a
   CONFIDENT, substantive answer with no supporting tool.result / RAG hit in the
   turn is a hallucination. An HONEST REFUSAL ("I don't have that") is CORRECT
   behaviour — never flag it. Do not reward refusals; do not punish them.
2. **Name the REAL failing component.** An empty RAG store is Postgres/pgvector +
   missing `pnpm brain:sync`, NOT "Ollama down". Never collapse distinct failures.
3. **Regression-test-FIRST (rule #19).** For every issue you decide to fix:
   a. Write a FAILING test that reproduces it on the real code path.
   b. Run it; confirm it fails for the right reason.
   c. Write the minimal fix.
   d. Run the test; confirm it passes. Run `pnpm gate` (lint + full suite).
   No reproducing test → no fix in the PR.
4. **Stay inside the guardrails.** Do not edit protected files (`src/core/config.ts`,
   `src/db/schema.ts`, `.env*`, `.github/**`). Flag those for manual review instead.
   Keep the diff small: ≤ 3 files / ≤ 120 changed lines. Larger → flag for manual.
5. **PR only, never merge.**

## Output
For each confirmed issue: severity, the real root cause, the failing test you wrote,
the fix, and the passing result. Then a single PR body summarizing all fixes with the
new tests shown. If NOTHING is confirmed, say so plainly and open NO PR.
```

- [ ] **Step 2: Commit**

```bash
git add scripts/log-review/stage3-prompt.md
git commit -m "feat(log-review): Stage-3 Claude prompt (regression-test-first, hallucination judging)"
```

---

## Task 10: `weekly-qa-audit.sh` — thin orchestrator (the 3 P0 fixes live here)

Replaces the inline-python VPS version. Runs in `/opt/founderos-qa`, gates the PR on a green build, moves `GITHUB_TOKEN` off the cmdline, notifies Telegram + writes the report.

**Files:**
- Create: `scripts/weekly-qa-audit.sh`

- [ ] **Step 1: Write the orchestrator**

```bash
#!/usr/bin/env bash
# Weekly QA auditor — thin orchestrator. Stages 1–2 run in TS (zero Claude tokens);
# Claude enters only at Stage 3 over a bounded digest. PR only — a human merges.
set -euo pipefail

# --- config (env-overridable) ---
QA_DIR="${QA_DIR:-/opt/founderos-qa}"          # isolated workspace, NOT the live deploy
WINDOW_DAYS="${WINDOW_DAYS:-7}"
TENANT="${TENANT:-turicks}"
DATE="$(date -u +%Y-%m-%d)"
DIGEST="${QA_DIR}/digest.json"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
TG_TOKEN="${TELEGRAM_BOT_TOKEN:?missing}"
TG_CHAT="${FOUNDER_CHAT_ID:?missing}"

notify() { curl -s "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TG_CHAT}" --data-urlencode "text=$1" >/dev/null || true; }

# --- isolated workspace: clean checkout of origin/main ---
cd "$QA_DIR"
git fetch origin --quiet
git reset --hard origin/main --quiet
git clean -fd --quiet
pnpm install --frozen-lockfile --silent

# --- Stage 1+2: harvest (zero Claude tokens) ---
journalctl -u founderos --since "${WINDOW_DAYS} days ago" -o cat --no-pager \
  | grep -E '"seam"|"level":(4|5)0' \
  | pnpm -s logreview --days="${WINDOW_DAYS}" --tenant="${TENANT}" --out="${DIGEST}"

SUMMARY="$(cat "${DIGEST%.json}.summary.txt")"

# --- pre-check: is there anything worth a Claude pass? ---
HARD="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${DIGEST}')).hardAnomalies.length)")"
STATE="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${DIGEST}')).stateFindings.length)")"
BORDER="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${DIGEST}')).borderlineTurns.length)")"

# Always write the report + Telegram digest (notify=both, decided).
REPORT="docs/reviews/${DATE}-prod-review.md"
mkdir -p docs/reviews
printf '# Prod review %s\n\n```\n%s\n```\n' "$DATE" "$SUMMARY" > "$REPORT"
notify "📋 Weekly prod QA (${DATE})%0A${SUMMARY:0:3500}"

if [ "$HARD" -eq 0 ] && [ "$STATE" -eq 0 ] && [ "$BORDER" -eq 0 ]; then
  notify "✅ No anomalies this week — no PR."
  exit 0
fi

# --- branch keyed on issue-set content hash (cross-week dedup) ---
HASH="$(node -e "console.log(JSON.parse(require('fs').readFileSync('${DIGEST}')).contentHash)")"
BRANCH="fix/weekly-qa-${HASH}"
if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  notify "↩️ Issue set ${HASH} already has open branch ${BRANCH} — skipping duplicate PR."
  exit 0
fi
git checkout -b "$BRANCH"

# --- Stage 3: Claude reasons over the digest only, in this isolated workspace ---
PROMPT="$(cat scripts/log-review/stage3-prompt.md)
Here is digest.json:
$(cat "$DIGEST")"
"$CLAUDE_BIN" -p --dangerously-skip-permissions --add-dir "$QA_DIR" "$PROMPT" || true

# --- P0-1: GATE the PR on a green build. Red build => no PR, founder reviews. ---
if ! pnpm lint >/tmp/qa-lint.log 2>&1; then
  notify "🛑 Auto-fix produced a RED tsc — NO PR. See ${REPORT}. Manual review needed."
  exit 1
fi
if ! pnpm test >/tmp/qa-test.log 2>&1; then
  notify "🛑 Auto-fix FAILED tests — NO PR. See ${REPORT}. Manual review needed."
  exit 1
fi

# --- diff-size guardrail (precise: <=3 files / <=120 lines) ---
FILES_CHANGED="$(git diff --name-only origin/main | wc -l | tr -d ' ')"
LINES_CHANGED="$(git diff --numstat origin/main | awk '{s+=$1+$2} END {print s+0}')"
if [ "$FILES_CHANGED" -gt 3 ] || [ "$LINES_CHANGED" -gt 120 ]; then
  notify "🛑 Diff too large (${FILES_CHANGED} files / ${LINES_CHANGED} lines) — escalating to manual. NO PR."
  exit 1
fi

# --- protected-file denylist ---
if git diff --name-only origin/main | grep -qE 'src/core/config\.ts|src/db/schema\.ts|\.env|^\.github/'; then
  notify "🛑 Patch touches a PROTECTED file — escalating to manual. NO PR."
  exit 1
fi

if [ "$FILES_CHANGED" -eq 0 ]; then
  notify "ℹ️ Claude confirmed no actionable fix this week — report written, no PR."
  exit 0
fi

# --- commit + push (GITHUB_TOKEN via GIT_ASKPASS, off the cmdline) ---
git add -A
git commit -q -m "fix(qa): weekly auto-audit ${DATE} (${HASH})"
export GIT_ASKPASS="$QA_DIR/scripts/git-askpass.sh"  # echoes $GITHUB_TOKEN
git push -u origin "$BRANCH" --quiet
gh pr create --title "Weekly QA auto-fix ${DATE}" \
  --body "$(printf 'Automated weekly QA. Human merges only.\n\n%s\n\nReport: %s' "$SUMMARY" "$REPORT")" \
  || notify "⚠️ gh pr create failed — branch ${BRANCH} pushed, open PR manually."
notify "✅ Weekly QA PR opened on ${BRANCH}. Review + merge."
```

- [ ] **Step 2: Add the GIT_ASKPASS helper (keeps the token out of `ps`/logs)**

```bash
# scripts/git-askpass.sh
#!/usr/bin/env bash
# Git credential helper: emit the token from env, never the cmdline.
echo "${GITHUB_TOKEN}"
```

- [ ] **Step 3: Make both executable + shellcheck**

```bash
chmod +x scripts/weekly-qa-audit.sh scripts/git-askpass.sh
shellcheck scripts/weekly-qa-audit.sh scripts/git-askpass.sh || true
```
Expected: no errors (warnings about `--data-urlencode` are fine).

- [ ] **Step 4: Commit**

```bash
git add scripts/weekly-qa-audit.sh scripts/git-askpass.sh
git commit -m "feat(log-review): orchestrator gates PR on green build + isolated workspace (P0-1)"
```

---

## Task 11: cross-week memory + ADR + runbook

**Files:**
- Create: `docs/decisions/026-weekly-qa-auditor.md`
- Create: `docs/runbooks/qa-workspace-setup.md`

- [ ] **Step 1: Confirm the next ADR number**

Run: `ls docs/decisions | sort | tail -3`
Expected: highest is `025-*`. If not, bump `026` accordingly in the filename + below.

- [ ] **Step 2: Write the ADR**

```markdown
# ADR-026: Weekly QA Auditor — deterministic funnel, Claude-judged, PR-only

## Status
Accepted — 2026-06-15

## Context
The inline-bash `weekly-qa-audit.sh` (installed 2026-06-15, never run) had 3 P0 flaws:
opened PRs on a broken build; inverted hallucination detection (flagged honest refusals,
missed confident fabrication — the canonical 2026-06-15 RAG-empty outage); fixed without a
reproducing test. It was also blind to DB state and embedded raw logs (token cost).

## Decision
A 3-stage funnel: deterministic TS harvest+triage (`scripts/log-review/`, unit-tested, zero
Claude tokens) → bounded `digest.json` → single Claude pass that judges hallucination, names
the real failing component, and writes regression-test-first fixes → PR a human merges.

Key decisions: Stage-3 runs on the VPS in an ISOLATED `/opt/founderos-qa` workspace (never the
live deploy); notify = Telegram + Markdown report; diff cap = 3 files / 120 lines; state-checks
reuse `src/db/queries.ts` + read-only count helpers; branch named by issue-set content hash
(cross-week dedup); `GITHUB_TOKEN` via `GIT_ASKPASS`.

## Consequences
- Raw logs never enter Claude context (token-frugal, reproducible).
- A red build can never become a PR (P0-1). Honest refusals are never punished (P0-2). Every
  fix carries a reproducing test (P0-3, rule #19).
- DB STATE is verified, not just schema (rule #22).
- Future hardening: container sandbox for Stage-3; Ollama dedup lever. Not built now (YAGNI).
```

- [ ] **Step 3: Write the VPS runbook**

```markdown
# Runbook: QA auditor workspace on the VPS

## One-time setup
```bash
# As root on 95.217.162.12
useradd -m -s /bin/bash founderos-qa || true
git clone https://github.com/pushkarverma3698/FounderOS.git /opt/founderos-qa
chown -R founderos-qa:founderos-qa /opt/founderos-qa
sudo -u founderos-qa bash -c 'cd /opt/founderos-qa && pnpm install --frozen-lockfile'
# Provide /opt/founderos-qa/.env (DATABASE_URL read-only role preferred, TELEGRAM_BOT_TOKEN,
# FOUNDER_CHAT_ID, GITHUB_TOKEN with repo scope, ANTHROPIC_API_KEY for the judge gate).
```

## Cron (replaces the disabled inline version)
```cron
30 17 * * 0 cd /opt/founderos-qa && QA_DIR=/opt/founderos-qa bash scripts/weekly-qa-audit.sh >> /var/log/founderos-qa.log 2>&1
```
Install as the `founderos-qa` user: `sudo -u founderos-qa crontab -e`.

## On-demand
`cd /opt/founderos-qa && journalctl -u founderos --since "7 days ago" -o cat | pnpm logreview --days=7`
(harvest only — zero Claude tokens; run the orchestrator for the full Stage-3 + PR flow.)

## Safety
- `founderos-qa` has NO write access to `/opt/founderos` (the live deploy).
- The orchestrator never merges. Humans merge PRs.
- The old inline cron under user `founderos` stays DISABLED (commented).
```

- [ ] **Step 4: Commit**

```bash
git add docs/decisions/026-weekly-qa-auditor.md docs/runbooks/qa-workspace-setup.md
git commit -m "docs(log-review): ADR-026 + VPS QA workspace runbook"
```

---

## Task 12: full-suite gate + memory + finish

- [ ] **Step 1: Run the whole gate**

Run: `pnpm gate`
Expected: lint clean + all tests green (existing + new log-review tests).

- [ ] **Step 2: Update MEMORY index**

Add one line to `/Users/pushkarverma/.claude/projects/-Users-pushkarverma-Projects-founderos/memory/MEMORY.md`:
```
- [Weekly QA auditor rebuild 2026-06-15](weekly-qa-auditor-rebuild-2026-06-15.md) — replaced flawed inline cron with scripts/log-review/ 3-stage funnel (harvest+triage=0 tokens → bounded digest → Claude judges in Stage 3 → PR human merges). Fixed 3 P0s: gate PR on green build, hallucination=Claude-judged-not-keyword (honest refusals NEVER flagged), regression-test-first. Isolated /opt/founderos-qa workspace. `pnpm logreview`. ADR-026.
```
And create that topic file with the same detail.

- [ ] **Step 3: Commit**

```bash
git add ../../.claude 2>/dev/null; git add -A
git commit -m "docs: memory index — weekly QA auditor rebuild"
```

- [ ] **Step 4: Push + open PR (human merges)**

```bash
git push -u origin feat/weekly-qa-rebuild
gh pr create --title "Weekly QA auditor rebuild — deterministic funnel, Claude-judged, PR-only" \
  --body "$(cat <<'EOF'
## Summary
- Replaces the flawed inline `weekly-qa-audit.sh` with `scripts/log-review/` 3-stage funnel.
- Stages 1–2 (harvest+triage) are pure, unit-tested TypeScript — zero Claude tokens.
- Stage 3 (Claude) reads a hard-capped digest only, judges hallucination, writes
  regression-test-first fixes, opens a PR a human merges.
- Fixes 3 P0s: PR gated on green build; honest refusals never flagged; reproducing test per fix.
- DB state-checks (rule #22). Isolated `/opt/founderos-qa` workspace. Old cron DISABLED on VPS.

## Test Plan
- [ ] `pnpm gate` green
- [ ] `pnpm logreview` over the committed fixture produces a bounded digest
- [ ] VPS: provision `/opt/founderos-qa` per runbook, dry-run orchestrator, confirm PR-gating on a forced red build
EOF
)"
```

---

## Self-Review (completed)

- **Spec coverage:** 3-stage funnel (T2–T8), 3 P0 fixes (T3 P0-2, T10 P0-1, T9 prompt P0-3), state-checks/rule #22 (T6), cross-week content-hash dedup (T4+T10), guardrails diff-cap+denylist+GIT_ASKPASS (T10), isolated workspace (T10+T11), notify both (T10), token guarantees (harvest never calls Claude, T8), testing incl. real fixture (T7), interim cron disable (T0). All spec sections map to a task.
- **Placeholder scan:** no TBD/TODO; every code step shows full code; Step-1 of T6 flags the one real-name lookup (RAG table) with an explicit fallback instruction rather than a placeholder.
- **Type consistency:** `LogLine`/`Turn`/`Anomaly`/`StateFinding`/`Digest` defined in T1 and used unchanged in T2–T8; `buildTimeline`, `runDetectors`, `buildDigest`, `assembleDigest`, `renderSummary`, `runStateChecks`, `parseLogLines` names consistent across tasks and the fixture test.
