/**
 * Reality Benchmark runner — collect a real run, don't author a scorecard.
 * =========================================================================
 * `pnpm verify:benchmark` exists because Phase 0 was reported complete with a
 * scorecard written from code inspection: 34 tasks scored, 0 transcripts, 33 of
 * 34 prompts never sent to the bot. This script is the other half — the thing
 * that makes producing REAL evidence cheaper than inventing fake evidence.
 *
 * It cannot manufacture a passing run. It records only what the live bot
 * actually replied, and the verifier still demands that every turnId appear in a
 * journald export this script does not write.
 *
 *   # 1. send the canonical prompts to PROD and capture verbatim replies
 *   pnpm benchmark:run
 *
 *   # 2. export the corroboration (on your machine, needs VPS access)
 *   ssh founderos-vps 'sudo -n journalctl -u founderos --since "<START>" --no-pager -o cat' \
 *     > docs/product-recovery/benchmark-runs/<file>.md.evidence.jsonl
 *
 *   # 3. fill in every turnId from that export
 *   pnpm benchmark:turnids docs/product-recovery/benchmark-runs/<file>.md
 *
 *   # 4. score each task by hand, then gate it
 *   pnpm verify:benchmark docs/product-recovery/benchmark-runs/<file>.md
 *
 * WHAT IS STILL YOURS: the scores. This writes `_` placeholders for all eight
 * dimensions, which the verifier rejects — so a file it produced can never pass
 * until a human has actually judged every task. Defaulting them to 0 would have
 * let an unscored run through, which is the same class of defect as the
 * scorecard that started all this.
 *
 * GROUP D (adversarial) and E4 (leakage) have no canonical wording — they are
 * setups the runner performs by hand. Those blocks are scaffolded with a
 * `**setup:**` line for you to fill in or mark `NOT RUN — <reason>`, which costs
 * nothing and is never counted as a failure.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CANONICAL } from "./verify-benchmark-run.js";
import { connect, botUsername, sendAndCollect, sleep, type BotReply } from "./lib/mtproto.js";

const OUT_DIR = "docs/product-recovery/benchmark-runs";
const DIMENSIONS = "intent source completeness artifact delivery truthfulness leakage friction";
/** Seconds to wait for the bot on each task before moving on. */
const WAIT_S = parseInt(process.env["BENCHMARK_WAIT_S"] ?? "60", 10);
/** Pause between tasks so a slow async reply lands against the right prompt. */
const GAP_MS = parseInt(process.env["BENCHMARK_GAP_MS"] ?? "4000", 10);

const IDS = Object.keys(CANONICAL);

interface Collected {
  readonly id: string;
  readonly prompt: string;
  readonly sentAt: string;
  readonly replyText: string;
  readonly sendError?: string;
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** Every reply the bot sent for one prompt, joined — a multi-message answer is still one answer. */
function joinReplies(replies: BotReply[]): string {
  return replies.map((r) => r.text).join("\n\n---\n\n").trim();
}

// ── `run` ─────────────────────────────────────────────────────────────────────

/** A task the runner performs itself: canonical wording exists for it. */
const isAutomatable = (id: string): boolean => (CANONICAL[id] ?? "") !== "";

function selectIds(argv: string[]): string[] {
  const only = argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
  const from = argv.find((a) => a.startsWith("--from="))?.slice("--from=".length);

  let ids = IDS.filter(isAutomatable);
  if (only) {
    const wanted = new Set(only.split(",").map((s) => s.trim().toUpperCase()));
    const unknown = [...wanted].filter((w) => !IDS.includes(w));
    if (unknown.length > 0) fail(`unknown task id(s): ${unknown.join(", ")}`);
    ids = ids.filter((id) => wanted.has(id));
  }
  if (from) {
    const start = ids.indexOf(from.toUpperCase());
    if (start < 0) fail(`--from=${from} is not an automatable task id`);
    ids = ids.slice(start);
  }
  return ids;
}

/** One task's markdown block, in exactly the shape verify-benchmark-run.ts parses. */
function renderBlock(c: Collected): string {
  if (c.sendError) {
    return [
      `### ${c.id}`,
      `- **prompt sent:** \`${c.prompt}\``,
      `- NOT RUN — Telegram refused the send: ${c.sendError}`,
      "",
    ].join("\n");
  }

  if (!c.replyText) {
    return [
      `### ${c.id}`,
      `- **prompt sent:** \`${c.prompt}\``,
      `- **sent at:** ${c.sentAt}`,
      `- NOT RUN — the bot sent no reply within ${WAIT_S}s. Re-run this task with --only=${c.id}, or leave this line to record the silence honestly.`,
      "",
    ].join("\n");
  }

  return [
    `### ${c.id}`,
    `- **prompt sent:** \`${c.prompt}\``,
    `- **sent at:** ${c.sentAt}`,
    `- **turnId:** FILL-ME (run: pnpm benchmark:turnids <this file>)`,
    `- **reply:**`,
    "```text",
    c.replyText,
    "```",
    `- **scores:** ${DIMENSIONS.split(" ").map((d) => `${d}=_`).join(" ")}`,
    `- **total:** _/8`,
    "",
  ].join("\n");
}

/** A block for a task only a human can set up. Left unscored and unrun by design. */
function renderManualBlock(id: string): string {
  return [
    `### ${id}`,
    `- **setup:** FILL ME — describe what you actually did to set this task up`,
    `- **sent at:** `,
    `- **turnId:** `,
    `- **reply:**`,
    "```text",
    "",
    "```",
    `- **scores:** ${DIMENSIONS.split(" ").map((d) => `${d}=_`).join(" ")}`,
    `- **total:** _/8`,
    `<!-- If you could not run this, replace everything above except the heading with:`,
    `     - **setup:** <what it would have needed>`,
    `     - NOT RUN — <reason>   (costs nothing, never counts as a failure) -->`,
    "",
  ].join("\n");
}

function renderRun(collected: Collected[], startedAt: string): string {
  const manual = IDS.filter((id) => !isAutomatable(id));
  const byId = new Map(collected.map((c) => [c.id, c]));

  const head = [
    `# Reality Benchmark run — ${startedAt.slice(0, 10)}`,
    "",
    `Collected by \`pnpm benchmark:run\` against the LIVE production bot.`,
    `Run started: ${startedAt}`,
    "",
    `**This file does not pass \`pnpm verify:benchmark\` yet, by design.** Three things are missing:`,
    "",
    `1. \`turnId\` on every task — run \`pnpm benchmark:turnids <this file>\` after exporting journald.`,
    `2. The journald export itself, at \`<this file>.evidence.jsonl\`.`,
    `3. The scores. Every dimension is \`_\`; you score them. The runner never guesses a score.`,
    "",
    `Automated: ${collected.length} task(s). Manual (Group D + E4): ${manual.length}.`,
    "",
    "## Tasks",
    "",
  ].join("\n");

  const blocks = IDS.map((id) => {
    const c = byId.get(id);
    return c ? renderBlock(c) : isAutomatable(id) ? "" : renderManualBlock(id);
  }).filter(Boolean);

  return `${head}${blocks.join("\n")}`;
}

async function cmdRun(argv: string[]): Promise<void> {
  const ids = selectIds(argv);
  if (ids.length === 0) fail("no tasks selected");

  const startedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const outPath = argv.find((a) => a.startsWith("--out="))?.slice("--out=".length)
    ?? join(OUT_DIR, `${startedAt.slice(0, 10)}-baseline.md`);

  console.log(`Reality Benchmark — ${ids.length} automatable task(s)`);
  console.log(`Run started (UTC): ${startedAt}`);
  console.log(`\n>>> KEEP THIS TIMESTAMP. The journald export must start at or before it:`);
  console.log(`    ssh founderos-vps 'sudo -n journalctl -u founderos --since "${startedAt.replace("T", " ").replace("Z", "")}" --no-pager -o cat' \\`);
  console.log(`      > ${outPath}.evidence.jsonl\n`);

  const client = await connect();
  const peer = await botUsername();
  console.log(`Connected. Sending as the founder to @${peer}.\n`);

  const collected: Collected[] = [];
  const rawPath = `${outPath}.raw.jsonl`;
  mkdirSync(dirname(outPath), { recursive: true });

  const raw: string[] = [];
  for (const [i, id] of ids.entries()) {
    const prompt = CANONICAL[id]!;
    process.stdout.write(`[${i + 1}/${ids.length}] ${id}  "${prompt.slice(0, 52)}"  … `);

    const res = await sendAndCollect(client, peer, prompt, WAIT_S);
    const replyText = joinReplies(res.replies);
    const entry: Collected = {
      id,
      prompt,
      sentAt: res.sentAt,
      replyText,
      ...(res.sendError ? { sendError: res.sendError } : {}),
    };
    collected.push(entry);
    raw.push(JSON.stringify({ ...entry, replies: res.replies }));

    console.log(res.sendError ? `SEND REJECTED` : replyText ? `${res.replies.length} reply msg(s)` : `NO REPLY (${WAIT_S}s)`);

    // Written after every task so a crash at task 30 does not cost the first 29.
    writeFileSync(rawPath, `${raw.join("\n")}\n`);
    writeFileSync(outPath, renderRun(collected, startedAt));

    if (i < ids.length - 1) await sleep(GAP_MS);
  }

  await client.disconnect();

  console.log(`\nWrote ${outPath}`);
  console.log(`Raw capture: ${rawPath}`);
  console.log(`\nNext:`);
  console.log(`  1. export journald (command printed above)`);
  console.log(`  2. pnpm benchmark:turnids ${outPath}`);
  console.log(`  3. score every task, then: pnpm verify:benchmark ${outPath}`);
}

// ── `turnids` ─────────────────────────────────────────────────────────────────

/** Same normalization the verifier uses, so a match here means a match there. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9@.]+/g, " ").trim();
}

interface TurnInEvent {
  readonly turnId: string;
  readonly preview: string;
}

/** Pull every `turn.in` seam out of a journald export (pino JSON, one object per line). */
function parseTurnIns(evidence: string): TurnInEvent[] {
  const out: TurnInEvent[] = [];
  for (const line of evidence.split("\n")) {
    const start = line.indexOf("{");
    if (start < 0) continue;
    try {
      const obj = JSON.parse(line.slice(start)) as {
        turnId?: string;
        seam?: string;
        data?: { textPreview?: string; prompt?: string };
      };
      if (obj.seam !== "turn.in" || !obj.turnId) continue;
      out.push({ turnId: obj.turnId, preview: obj.data?.textPreview ?? obj.data?.prompt ?? "" });
    } catch {
      /* journald carries non-JSON lines too (systemd banners); skipping them is correct */
    }
  }
  return out;
}

function cmdTurnIds(argv: string[]): void {
  const runPath = argv[0];
  if (!runPath) fail("usage: pnpm benchmark:turnids <benchmark-run.md> [evidence.jsonl]");
  if (!existsSync(runPath)) fail(`benchmark run not found: ${runPath}`);

  const evidencePath = argv[1] ?? `${runPath}.evidence.jsonl`;
  if (!existsSync(evidencePath)) {
    fail(
      `no journald export at ${evidencePath}\n` +
        `  Produce it with:\n` +
        `    ssh founderos-vps 'sudo -n journalctl -u founderos --since "<run start>" --no-pager -o cat' > ${evidencePath}`,
    );
  }

  const turnIns = parseTurnIns(readFileSync(evidencePath, "utf8"));
  if (turnIns.length === 0) {
    fail(`${evidencePath} contains no \`turn.in\` trace events — wrong service, wrong window, or the export is empty.`);
  }

  const { markdown, filled, unmatched } = fillTurnIds(readFileSync(runPath, "utf8"), turnIns);
  writeFileSync(runPath, markdown);

  console.log(`turn.in events in export: ${turnIns.length}`);
  console.log(`turnIds filled: ${filled}`);
  if (unmatched.length > 0) {
    console.log(`\nNo matching turn found for: ${unmatched.join(", ")}`);
    console.log(`These stay FILL-ME. Either the export window misses them, or those prompts never reached the bot.`);
    console.log(`Both are real findings — do not hand-write a turnId to make the verifier pass.`);
  }
  console.log(`\nNext: score every task, then pnpm verify:benchmark ${runPath}`);
}

export interface FillResult {
  readonly markdown: string;
  readonly filled: number;
  /** Task ids whose prompt matched no turn in the export. Never silently skipped. */
  readonly unmatched: string[];
}

/**
 * Replace every `**turnId:** FILL-ME` with the turnId of the turn that carried
 * that task's prompt. Pure, so the matching rules are testable without a file.
 */
export function fillTurnIds(source: string, turnIns: readonly TurnInEvent[]): FillResult {
  const lines = source.split("\n");
  const used = new Set<string>();
  let filled = 0;
  const unmatched: string[] = [];

  // ONE forward pass. Within a task block the prompt line always precedes the
  // turnId line, so by the time a FILL-ME is reached its prompt is known. Each
  // FILL-ME claims the FIRST still-unused turnId whose logged preview matches:
  // the same prompt can legitimately appear twice in a run (a task re-sent with
  // --only), and claiming in file order pairs each attempt with its own turn
  // instead of collapsing both onto one.
  let currentId = "";
  let currentPrompt = "";

  for (const [i, line] of lines.entries()) {
    const heading = line.match(/^###\s+(\S+)/);
    if (heading) {
      currentId = heading[1]!.toUpperCase();
      currentPrompt = "";
      continue;
    }

    const prompt = line.match(/^\s*[-*]\s*\*\*prompt sent:\*\*\s*(.+)$/i);
    if (prompt) {
      currentPrompt = normalize(prompt[1]!.replace(/^[`"']|[`"']$/g, "").trim());
      continue;
    }

    if (!/^\s*[-*]\s*\*\*turnId:\*\*\s*FILL-ME/i.test(line)) continue;
    if (!currentPrompt) continue; // manual block: nothing to match against

    // Match on a prefix: journald stores textPreview truncated to 120 chars.
    const needle = currentPrompt.slice(0, 40);
    const hit = turnIns.find((t) => !used.has(t.turnId) && normalize(t.preview).startsWith(needle));

    if (!hit) {
      unmatched.push(currentId);
      continue;
    }
    used.add(hit.turnId);
    filled++;
    lines[i] = line.replace(/^(\s*[-*]\s*\*\*turnId:\*\*\s*)FILL-ME.*$/i, `$1${hit.turnId}`);
  }

  return { markdown: lines.join("\n"), filled, unmatched };
}

// ── entry ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [cmd, ...argv] = process.argv.slice(2);
  if (cmd === "run") return cmdRun(argv);
  if (cmd === "turnids") return cmdTurnIds(argv);
  fail("usage: run-benchmark.ts <run|turnids> [args]\n  run      [--only=A1,B2] [--from=C3] [--out=path.md]\n  turnids  <run.md> [evidence.jsonl]");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}

export { parseTurnIns, renderBlock, renderManualBlock, selectIds, normalize };
export type { TurnInEvent };
