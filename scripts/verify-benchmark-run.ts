/**
 * verify-benchmark-run.ts — mechanical gate on a Reality Benchmark run.
 *
 * Phase 0 was reported complete with a scorecard authored from code inspection:
 * 34 tasks scored, 0 transcripts, 33 of 34 prompts never sent to the bot. The
 * exit criterion "≥1 transcript each" was prose, and prose does not hold
 * (CLAUDE.md #27). This script is the layer that does.
 *
 * A benchmark run passes only when every one of the 34 tasks carries a turn that
 * actually happened: a prompt matching the canonical wording, a UUID turnId, a
 * verbatim reply, and per-dimension scores that sum to the stated total — with
 * every turnId corroborated by a raw journald export the runner did not author.
 *
 *   pnpm verify:benchmark docs/product-recovery/benchmark-runs/<file>.md
 *
 * Evidence file defaults to <file>.evidence.jsonl beside the run. Produce it with:
 *   ssh founderos-vps 'sudo -n journalctl -u founderos --since "<start>" --no-pager -o cat' \
 *     > docs/product-recovery/benchmark-runs/<file>.md.evidence.jsonl
 */

import { readFileSync, existsSync } from "node:fs";

/**
 * The canonical 34. Groups A/B/C/E carry founder wording; D carries a setup.
 *
 * EXPORTED so scripts/run-benchmark.ts sends exactly the strings this file
 * checks. If the runner kept its own copy, a one-word drift would fail every
 * task with "prompt does not match the canonical wording" after the founder had
 * already spent the session collecting replies. One list, one source.
 */
export const CANONICAL: Record<string, string> = {
  A1: "what all jobs has been captured give me a csv",
  A2: "how many jobs are in the pipeline",
  A3: "which ones have i already applied to",
  A4: "which applications are waiting on me",
  A5: "what did the job search cost last week",
  A6: "export that as a spreadsheet",
  A7: "show me everything you rejected and why",
  A8: "whats scheduled to run today",
  B1: "find me jobs",
  B2: "why did i get nothing today",
  B3: "apply to the top 3",
  B4: "stop showing me staff level roles",
  B5: "what companies keep coming up",
  C1: "email alex@acme.com a thank you",
  C2: "draft a linkedin post about",
  C3: "post it",
  C4: "open turicks.com and tell me if its up",
  C5: "check my github and tell me whats broken",
  C6: "fix that",
  C7: "deploy it",
  C8: "remind me tomorrow 9am to call the recruiter",
  D1: "", // adversarial setups: wording is the runner's, the setup line is required
  D2: "",
  D3: "",
  D4: "",
  D5: "",
  D6: "",
  D7: "",
  D8: "",
  D9: "",
  E1: "whats going on",
  E2: "what did we get done this week",
  E3: "what should i do next",
  E4: "", // leakage check rides on any request
};

const TOTAL_TASKS = Object.keys(CANONICAL).length;

const DIMENSIONS = [
  "intent",
  "source",
  "completeness",
  "artifact",
  "delivery",
  "truthfulness",
  "leakage",
  "friction",
] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

interface TaskBlock {
  readonly id: string;
  readonly prompt: string;
  readonly sentAt: string;
  readonly turnId: string;
  readonly reply: string;
  readonly scores: Readonly<Record<string, string>>;
  readonly total: string;
  /** Honest non-execution: "NOT RUN — <reason>". Unscored, not a failure. */
  readonly notRunReason: string;
}

/** Lowercase, strip everything that is not a letter, digit, @ or . — punctuation drift is not a lie. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9@.]+/g, " ").trim();
}

function fieldOf(block: string, name: string): string {
  const m = block.match(new RegExp(`^\\s*[-*]\\s*\\*\\*${name}:\\*\\*\\s*(.+)$`, "im"));
  return m?.[1]?.replace(/^[\`"']|[\`"']$/g, "").trim() ?? "";
}

function parseTasks(markdown: string): TaskBlock[] {
  // Each task is "### <ID>" through the next "### " or "## ".
  const sections = markdown.split(/^###\s+/m).slice(1);
  const tasks: TaskBlock[] = [];

  for (const section of sections) {
    const id = section.slice(0, 4).trim().split(/\s/)[0]?.toUpperCase() ?? "";
    if (!(id in CANONICAL)) continue;

    const body = section.split(/^##\s+/m)[0] ?? section;
    const replyMatch = body.match(/```(?:text)?\n([\s\S]*?)```/);
    const scores: Record<string, string> = {};
    for (const dim of DIMENSIONS) {
      scores[dim] = body.match(new RegExp(`\\b${dim}\\s*=\\s*([01])\\b`, "i"))?.[1] ?? "";
    }

    tasks.push({
      id,
      prompt: fieldOf(body, "prompt sent") || fieldOf(body, "setup"),
      sentAt: fieldOf(body, "sent at"),
      turnId: fieldOf(body, "turnId"),
      reply: (replyMatch?.[1] ?? "").trim(),
      scores,
      total: body.match(/\*\*total:\*\*\s*(\d+)\s*\/\s*8/i)?.[1] ?? "",
      notRunReason: body.match(/NOT RUN\s*[—:-]\s*(.+)/i)?.[1]?.trim() ?? "",
    });
  }
  return tasks;
}

function checkTask(task: TaskBlock, seenTurnIds: Map<string, string>): string[] {
  const problems: string[] = [];
  const expected = CANONICAL[task.id] ?? "";

  // Honest non-execution costs nothing to declare and is never a failure — R4.
  // Invention is what this script is here to make expensive.
  if (task.notRunReason) {
    if (task.total !== "") problems.push("marked NOT RUN but also scored — a task that did not run has no score");
    return problems;
  }

  if (!task.prompt) problems.push("no `**prompt sent:**` (or `**setup:**` for Group D)");
  else if (expected && !normalize(task.prompt).includes(normalize(expected))) {
    problems.push(`prompt does not match the canonical wording — expected to contain "${expected}", got "${task.prompt}"`);
  }

  if (!ISO.test(task.sentAt)) problems.push(`\`sent at\` is not an ISO-8601 UTC instant: "${task.sentAt}"`);
  if (!UUID.test(task.turnId)) problems.push(`\`turnId\` is not a UUID: "${task.turnId}"`);
  else {
    const owner = seenTurnIds.get(task.turnId.toLowerCase());
    if (owner) problems.push(`turnId reused from ${owner} — one turn cannot score two tasks`);
    else seenTurnIds.set(task.turnId.toLowerCase(), task.id);
  }

  if (!task.reply) problems.push("no verbatim reply block (fenced ``` block, the bot's actual text)");

  const missing = DIMENSIONS.filter((d) => task.scores[d] === "");
  if (missing.length > 0) problems.push(`missing dimension scores: ${missing.join(", ")}`);
  else {
    const sum = DIMENSIONS.reduce((acc, d) => acc + Number(task.scores[d]), 0);
    if (!task.total) problems.push("no `**total:** N/8`");
    else if (Number(task.total) !== sum) problems.push(`total ${task.total}/8 does not equal the sum of its dimensions (${sum})`);
  }

  return problems;
}

function main(): void {
  const runPath = process.argv[2];
  if (!runPath) {
    console.error("usage: pnpm verify:benchmark <benchmark-run.md> [evidence.jsonl]");
    process.exit(2);
  }
  if (!existsSync(runPath)) {
    console.error(`FAIL — benchmark run not found: ${runPath}`);
    process.exit(1);
  }

  const evidencePath = process.argv[3] ?? `${runPath}.evidence.jsonl`;
  const markdown = readFileSync(runPath, "utf8");
  const tasks = parseTasks(markdown);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const failures: string[] = [];

  const missingIds = Object.keys(CANONICAL).filter((id) => !byId.has(id));
  if (missingIds.length > 0) {
    failures.push(`${missingIds.length} of ${TOTAL_TASKS} tasks have no evidence block: ${missingIds.join(", ")}`);
  }

  const seenTurnIds = new Map<string, string>();
  for (const task of tasks) {
    for (const problem of checkTask(task, seenTurnIds)) failures.push(`${task.id}: ${problem}`);
  }

  // The corroboration check. A scorecard authored without running anything cannot
  // pass this without forging a journald export.
  if (!existsSync(evidencePath)) {
    failures.push(
      `no raw evidence export at ${evidencePath} — every turnId must be corroborated by prod logs the runner did not write`,
    );
  } else {
    const evidence = readFileSync(evidencePath, "utf8");
    for (const [turnId, id] of seenTurnIds) {
      if (!evidence.toLowerCase().includes(turnId)) {
        failures.push(`${id}: turnId ${turnId} does not appear in ${evidencePath} — the turn is not corroborated`);
      }
    }
  }

  const notRun = tasks.filter((t) => t.notRunReason !== "");
  const scored = tasks.filter((t) => t.notRunReason === "" && t.total !== "");
  const perfect = scored.filter((t) => Number(t.total) === 8).length;
  const truthful = scored.filter((t) => t.scores["truthfulness"] === "1").length;

  console.log(`Benchmark run: ${runPath}`);
  console.log(`Tasks with an evidence block: ${tasks.length}/${TOTAL_TASKS} (${notRun.length} declared NOT RUN)`);
  if (scored.length > 0) {
    console.log(`Objective completion (8/8): ${perfect}/${scored.length} = ${((perfect / scored.length) * 100).toFixed(1)}%`);
    console.log(`Truthfulness: ${truthful}/${scored.length}`);
  }

  if (failures.length > 0) {
    console.error(`\nFAIL — ${failures.length} problem(s). This run is not a baseline.\n`);
    for (const failure of failures) console.error(`  · ${failure}`);
    console.error("\nSee docs/product-recovery/14-EXECUTOR-RULES.md § Benchmark evidence format.");
    process.exit(1);
  }

  console.log("\nPASS — every task is corroborated by a real turn.");
}

// Guarded so CANONICAL can be imported (scripts/run-benchmark.ts sends exactly
// these strings). Unguarded, `import` ran main() and exited the importing
// process with code 2 for want of an argv.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
