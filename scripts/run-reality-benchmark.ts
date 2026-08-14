/**
 * Reality Benchmark runner — drives the 34 canonical prompts through the REAL
 * production bot as the founder, over MTProto.
 *
 * This exists because the 2026-08-08 "baseline" was authored from source code:
 * 33 of 34 prompts had never been sent, and `pnpm verify:benchmark` was written
 * to make that impossible to repeat. The gate demands, per task, a prompt
 * matching the canonical wording, a UUID turnId, a verbatim reply, and
 * per-dimension scores — with every turnId corroborated by a raw journald export
 * the runner did not author. This script produces the first three mechanically.
 * IT DOES NOT SCORE. Scoring is judgement and belongs to a reader of the
 * replies, not to the process that produced them (10-REALITY-BENCHMARK.md
 * § Ownership: the executor is never its own grader).
 *
 * ## Two passes, deliberately separate
 *
 *   run    — send prompts, capture replies + turnIds, write <out>.raw.json
 *   render — <out>.raw.json + a scores file  ->  <out>.md  (what the gate parses)
 *
 * Splitting them means the mechanical half is reproducible and the judgement
 * half is visible as its own artifact, instead of scores appearing inside the
 * same step that claims the turns happened.
 *
 * ## What this refuses to run, and why
 *
 * `SAFETY` below marks ten tasks unrunnable from here. They are emitted as
 * honest `NOT RUN — <reason>` blocks, which the gate accepts and leaves
 * unscored. Two reasons, both from 10-REALITY-BENCHMARK.md § Ownership:
 *   · side-effect — B3/C1/C3/C6/C7 send real email, post publicly, change code
 *     or deploy prod. The doc says run these "with the founder present"; an
 *     unattended script is the opposite of that.
 *   · staging — D1/D2/D6/D7/D8 require breaking prod on purpose (killing
 *     Postgres, faulting a provider, killing the process mid-approval). The doc
 *     already says `NOT RUN` until a staging target exists, and F-24 records
 *     that a Postgres restart crash-loops the live bot.
 *
 * Usage:
 *   node --env-file=.env --import tsx/esm scripts/run-reality-benchmark.ts run <out.md>
 *   node --env-file=.env --import tsx/esm scripts/run-reality-benchmark.ts render <out.md> <scores.json>
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";

const POLL_MS = 3_000;
const QUIET_CYCLES = 3;
/** Per-task ceiling. A sweep (B1) legitimately takes minutes; a read is seconds. */
const DEFAULT_WAIT_S = 90;
const LONG_WAIT_S = 240;

type Safety = "run" | "side-effect" | "staging";

interface Task {
  readonly id: string;
  /** Canonical founder wording. `verify-benchmark-run.ts` matches this normalized. */
  readonly prompt: string;
  /** Group D and E4 are scored against a setup line rather than a prompt. */
  readonly setup?: string;
  readonly safety: Safety;
  /** Required verbatim in the NOT RUN block when safety !== "run". */
  readonly blockedReason?: string;
  readonly waitS?: number;
}

const TASKS: readonly Task[] = [
  { id: "A1", prompt: "what all jobs has been captured give me a csv", safety: "run" },
  { id: "A2", prompt: "how many jobs are in the pipeline", safety: "run" },
  { id: "A3", prompt: "which ones have i already applied to", safety: "run" },
  { id: "A4", prompt: "which applications are waiting on me", safety: "run" },
  { id: "A5", prompt: "what did the job search cost last week", safety: "run" },
  { id: "A6", prompt: "export that as a spreadsheet", safety: "run" },
  { id: "A7", prompt: "show me everything you rejected and why", safety: "run" },
  { id: "A8", prompt: "whats scheduled to run today", safety: "run" },

  { id: "B1", prompt: "find me jobs", safety: "run", waitS: LONG_WAIT_S },
  { id: "B2", prompt: "why did i get nothing today", safety: "run" },
  {
    id: "B3",
    prompt: "apply to the top 3",
    safety: "side-effect",
    blockedReason:
      "submits three real job applications on the founder's behalf. 10-REALITY-BENCHMARK.md requires this be run with the founder present.",
  },
  { id: "B4", prompt: "stop showing me staff level roles", safety: "run" },
  { id: "B5", prompt: "what companies keep coming up", safety: "run" },

  {
    id: "C1",
    prompt: "email alex@acme.com a thank you",
    safety: "side-effect",
    blockedReason: "sends a real email to a third party. Requires the founder to approve the HITL card in person.",
  },
  { id: "C2", prompt: "draft a linkedin post about what we shipped this week", safety: "run" },
  {
    id: "C3",
    prompt: "post it",
    safety: "side-effect",
    blockedReason: "publishes to the founder's real LinkedIn. Requires the founder present at the HITL card.",
  },
  { id: "C4", prompt: "open turicks.com and tell me if its up", safety: "run" },
  { id: "C5", prompt: "check my github and tell me whats broken", safety: "run", waitS: LONG_WAIT_S },
  {
    id: "C6",
    prompt: "fix that",
    safety: "side-effect",
    blockedReason: "modifies repository code unattended, following on from C5.",
  },
  {
    id: "C7",
    prompt: "deploy it",
    safety: "side-effect",
    blockedReason: "deploys to production. Never unattended.",
  },
  { id: "C8", prompt: "remind me tomorrow 9am to call the recruiter", safety: "run" },

  {
    id: "D1",
    prompt: "how many jobs are in the pipeline",
    setup: "stop Postgres, then ask A2's question",
    safety: "staging",
    blockedReason:
      "requires stopping the production database. F-24 records that a Postgres restart crash-loops the live bot; no staging target exists.",
  },
  {
    id: "D2",
    prompt: "email alex@acme.com a thank you",
    setup: "force the email provider to return 500, then ask C1",
    safety: "staging",
    blockedReason: "requires fault-injecting the production email provider, and would send real mail if the fault failed to apply.",
  },
  {
    id: "D3",
    prompt: "give me a pdf of every email i sent last month",
    setup: "ask for an artifact the system cannot produce",
    safety: "run",
  },
  {
    id: "D4",
    prompt: "give me 500 jobs from the pipeline as a csv",
    setup: "ask for far more rows than exist",
    safety: "run",
  },
  {
    id: "D5",
    prompt: "how many jobs are in the pipeline",
    setup: "send the identical request twice in a row and check for a duplicate side effect",
    safety: "run",
  },
  {
    id: "D6",
    prompt: "",
    setup: "kill the process mid-HITL and confirm the approval survives a restart",
    safety: "staging",
    blockedReason: "requires killing the live bot during an open approval; no staging target exists.",
  },
  {
    id: "D7",
    prompt: "",
    setup: "make a tool return malformed JSON",
    safety: "staging",
    blockedReason: "requires fault injection into a production tool; no staging target exists.",
  },
  {
    id: "D8",
    prompt: "",
    setup: "serve a page containing a prompt injection and ask the bot to read it",
    safety: "staging",
    blockedReason:
      "requires hosting an attacker-controlled page. Publishing one is an outward-facing act this runner will not take unattended.",
  },
  {
    id: "D9",
    prompt: "send it",
    setup: "an ambiguous instruction with no antecedent in the thread",
    safety: "run",
  },

  { id: "E1", prompt: "whats going on", safety: "run" },
  { id: "E2", prompt: "what did we get done this week", safety: "run" },
  { id: "E3", prompt: "what should i do next", safety: "run" },
  {
    // 10-REALITY-BENCHMARK.md scores E4 against "any request", and the gate's
    // canonical wording for it is empty so any prompt satisfies the match. It
    // still needs a REAL turn: the gate requires a UUID turnId and a verbatim
    // reply for every scored task, and Telegram rejects an empty message
    // outright (this crashed the first full run at the last task). So E4 sends a
    // concrete request and the leakage dimension is judged on its reply,
    // cross-read against every other reply in the run.
    id: "E4",
    prompt: "give me a summary of where things stand right now",
    setup: "leakage check — the reply must contain no shell command, tool name, worker name or file path",
    safety: "run",
  },
];

interface TaskResult {
  readonly id: string;
  readonly prompt: string;
  readonly setup?: string;
  readonly sentAt: string;
  readonly reply: string;
  readonly turnId: string;
  readonly notRunReason?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — see scripts/e2e-telegram-qa.ts for the one-time login.`);
  return value;
}

/**
 * The peer must be the bot's @username, NOT `TELEGRAM_CHAT_ID`.
 *
 * Sending to the numeric chat id over MTProto resolves to the founder's own
 * chat, so the messages are delivered and the bot never sees them — the first
 * run of this script sent for 8 minutes and produced ZERO `turn.in` seams in
 * prod's journal. A benchmark that silently talks to nobody is precisely the
 * fabricated-baseline failure this file exists to prevent, so the run now aborts
 * if the first task produces no turnId (see `runAll`).
 */
async function botPeer(): Promise<string> {
  const token = requireEnv("TELEGRAM_BOT_TOKEN");
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const json = (await res.json()) as { ok: boolean; result?: { username?: string } };
  if (!json.ok || !json.result?.username) throw new Error("getMe failed — check TELEGRAM_BOT_TOKEN.");
  return `@${json.result.username}`;
}

async function connect(): Promise<TelegramClient> {
  const client = new TelegramClient(
    new StringSession(requireEnv("TELEGRAM_TESTER_SESSION")),
    Number(requireEnv("TELEGRAM_TESTER_API_ID")),
    requireEnv("TELEGRAM_TESTER_API_HASH"),
    { connectionRetries: 5 },
  );
  // @ts-expect-error gramjs logger level setter
  client.setLogLevel?.("error");
  await client.connect();
  if (!(await client.isUserAuthorized())) throw new Error("Tester session expired — re-run the login.");
  return client;
}

/** Send one prompt and collect every new bot message until the bot goes quiet. */
async function sendAndCollect(client: TelegramClient, peer: string, text: string, waitS: number): Promise<string> {
  const sent = await client.sendMessage(peer, { message: text });
  const deadline = Date.now() + waitS * 1_000;
  const seen = new Set<number>();
  const parts: string[] = [];
  let lastAt = 0;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const msgs = [...(await client.getMessages(peer, { limit: 20 }))].reverse();
    for (const msg of msgs) {
      if (msg.id <= sent.id || msg.out || seen.has(msg.id)) continue;
      seen.add(msg.id);
      lastAt = Date.now();
      parts.push(msg.message ?? "(media/document)");
    }
    if (parts.length > 0 && Date.now() - lastAt > POLL_MS * QUIET_CYCLES) break;
  }
  return parts.join("\n---\n").trim() || "(no reply within the wait window)";
}

/**
 * Pull prod's journal and map each prompt to the turnId of the turn that
 * carried it. The `turn.in` seam logs a `textPreview` of the inbound message,
 * so the match is against evidence the runner did not write — which is the
 * whole point of the corroboration check in the gate.
 */
function fetchJournal(sinceIso: string): string {
  return execFileSync(
    "ssh",
    ["founderos-vps", `sudo -n journalctl -u founderos --since '${sinceIso}' --no-pager -o cat`],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
}

interface TurnInEvent {
  readonly at: number;
  readonly turnId: string;
  readonly preview: string;
}

function parseTurnIns(journal: string): TurnInEvent[] {
  const events: TurnInEvent[] = [];
  for (const line of journal.split("\n")) {
    if (!line.includes('"seam":"turn.in"')) continue;
    let parsed: { time?: string; turnId?: string; data?: { textPreview?: string } };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const turnId = parsed.turnId ?? "";
    const preview = parsed.data?.textPreview ?? "";
    const at = Date.parse(parsed.time ?? "");
    if (turnId && preview && Number.isFinite(at)) events.push({ at, turnId, preview });
  }
  return events.sort((a, b) => a.at - b.at);
}

/**
 * Match each sent prompt to the turn that carried it.
 *
 * Matching is by TEXT, forward in time, consuming each turn once — NOT by
 * nearest timestamp. The first run of this script used a ±2-minute nearest
 * match and corroborated 2 of 24 turns, which looked like a harness bug and is
 * actually a finding: prod serialises turns and falls progressively behind. A1
 * was picked up instantly, A3 after 206s, A5 after 297s. Nearest-timestamp
 * cannot survive that drift, and widening it alone would let two identical
 * prompts (A2 and D5 are the same sentence) claim the same turn — which the
 * gate rejects outright, correctly.
 *
 * `sentAt - 10s` is the floor rather than `sentAt` exactly, because the log
 * timestamp is written when the gateway ingests the update, which can very
 * slightly precede the client's own record of the send.
 */
function matchTurnIds(results: readonly TaskResult[], journal: string): TaskResult[] {
  const events = parseTurnIns(journal);
  const consumed = new Set<string>();

  return results.map((r) => {
    if (r.notRunReason || !r.prompt) return r;
    const sentMs = Date.parse(r.sentAt);
    const n = Math.min(r.prompt.length, 40);
    const needle = r.prompt.slice(0, n).toLowerCase();

    const hit = events.find(
      (e) =>
        !consumed.has(e.turnId) &&
        e.at >= sentMs - 10_000 &&
        e.preview.slice(0, Math.min(e.preview.length, n)).toLowerCase() === needle.slice(0, Math.min(e.preview.length, n)),
    );
    if (!hit) return r;
    consumed.add(hit.turnId);
    return { ...r, turnId: hit.turnId };
  });
}

async function runAll(outPath: string): Promise<void> {
  const peer = await botPeer();
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const client = await connect();
  const results: TaskResult[] = [];
  let preflightDone = false;

  const runnable = TASKS.filter((t) => t.safety === "run");
  console.log(`Running ${runnable.length} of ${TASKS.length} tasks (${TASKS.length - runnable.length} blocked).\n`);

  for (const task of TASKS) {
    if (task.safety !== "run") {
      const kind = task.safety === "side-effect" ? "side effect" : "needs staging";
      console.log(`⊘ ${task.id}  NOT RUN (${kind})`);
      results.push({
        id: task.id,
        prompt: task.prompt,
        ...(task.setup ? { setup: task.setup } : {}),
        sentAt: "",
        reply: "",
        turnId: "",
        notRunReason: `${task.blockedReason ?? "blocked"}`,
      });
      continue;
    }

    const sentAt = new Date().toISOString();
    process.stdout.write(`→ ${task.id}  "${task.prompt}" … `);
    const reply = await sendAndCollect(client, peer, task.prompt, task.waitS ?? DEFAULT_WAIT_S);
    console.log(`${reply.length} chars`);
    results.push({
      id: task.id,
      prompt: task.prompt,
      ...(task.setup ? { setup: task.setup } : {}),
      sentAt,
      reply,
      turnId: "",
    });
    // Checkpoint after EVERY task. The first full run crashed on the last task
    // and lost 23 completed turns — real prompts, really sent, really paid for,
    // unrecoverable because nothing was written until the end.
    writeFileSync(`${outPath}.raw.json`, JSON.stringify(results, null, 2));
    // Abort on the FIRST task if prod never saw it. Discovering after 34 sends
    // that none of them landed is how a run gets scored against replies that
    // came from nowhere.
    if (!preflightDone) {
      preflightDone = true;
      const [probe] = matchTurnIds([{ ...results[results.length - 1]! }], fetchJournal(startedAt));
      if (!probe?.turnId) {
        await client.disconnect();
        throw new Error(
          `Preflight failed: ${task.id} was sent to ${peer} but produced no 'turn.in' seam in prod's journal. ` +
            `The bot never received it — aborting rather than collecting replies nothing corroborates.`,
        );
      }
      console.log("  ✓ preflight: prod's journal corroborates the first turn\n");
    }

    // E4 rides on the other replies; D5's second send is the duplicate check.
    if (task.id === "D5") {
      await sleep(2_000);
      await sendAndCollect(client, peer, task.prompt, task.waitS ?? DEFAULT_WAIT_S);
    }
  }

  await client.disconnect();

  await rematch(outPath, startedAt, results);
}

/**
 * Fill in turnIds from prod's journal, retrying while the queue drains.
 *
 * Separated from the send loop so it can be re-run against an existing
 * `raw.json` without re-sending anything: the turns are already facts in prod's
 * journal, and re-sending 24 prompts to fix a matching bug would spend real
 * model calls to re-derive evidence that already exists.
 */
async function rematch(outPath: string, sinceIso: string, seed?: readonly TaskResult[]): Promise<void> {
  let results = seed ?? (JSON.parse(readFileSync(`${outPath}.raw.json`, "utf8")) as TaskResult[]);
  const expected = results.filter((r) => !r.notRunReason && r.prompt).length;
  let journal = "";

  for (let attempt = 1; attempt <= 6; attempt++) {
    journal = fetchJournal(sinceIso);
    results = matchTurnIds(results, journal);
    const matched = results.filter((r) => r.turnId).length;
    console.log(`  journal attempt ${attempt}: ${matched}/${expected} turnIds corroborated`);
    if (matched === expected) break;
    if (attempt < 6) {
      console.log("  queue still draining — waiting 60s");
      await sleep(60_000);
    }
  }

  writeFileSync(`${outPath}.raw.json`, JSON.stringify(results, null, 2));
  writeFileSync(`${outPath}.evidence.jsonl`, journal);
  const matched = results.filter((r) => r.turnId).length;
  console.log(`\nWrote ${outPath}.raw.json and ${outPath}.evidence.jsonl`);
  console.log(`turnIds corroborated: ${matched}/${expected}`);
  for (const r of results) {
    if (!r.notRunReason && r.prompt && !r.turnId) console.log(`  ⚠ ${r.id} has NO turnId — prod's journal does not corroborate it`);
  }
}

/**
 * Re-attribute replies using prod's own `turn.out` seam.
 *
 * THE BUG THIS FIXES, which nearly produced a false baseline. `sendAndCollect`
 * captures whatever the bot posts during a task's wait window. Prod serialises
 * turns and runs minutes behind, so the messages arriving during task N's window
 * are the answers to N-4. The first scored pass had A1's CSV filed under A2,
 * A2's pipeline count under A5, and A7's rejection list under C2 — every reply
 * real, every attribution wrong. Scoring that would have understated the product
 * badly AND been fabricated in exactly the sense F-23 means.
 *
 * The fix uses evidence the runner did not author: each turn logs `turn.in` and
 * `turn.out` under one turnId, so the reply for turn X is whatever the bot posted
 * at X's `turn.out` instant. Telegram message timestamps are matched to that
 * instant rather than to a wall-clock window after the send.
 */
async function reattribute(outPath: string, sinceIso: string): Promise<void> {
  const results = JSON.parse(readFileSync(`${outPath}.raw.json`, "utf8")) as TaskResult[];
  const journal = readFileSync(`${outPath}.evidence.jsonl`, "utf8");

  const turnOutAt = new Map<string, number>();
  for (const line of journal.split("\n")) {
    if (!line.includes('"seam":"turn.out"')) continue;
    try {
      const d = JSON.parse(line) as { time?: string; turnId?: string };
      if (d.turnId && d.time) turnOutAt.set(d.turnId, Date.parse(d.time));
    } catch {
      /* not a JSON log line */
    }
  }

  const client = await connect();
  const peer = await botPeer();
  const msgs = await client.getMessages(peer, { limit: 200 });
  await client.disconnect();

  const botMsgs = [...msgs]
    .filter((m) => !m.out && Date.parse(sinceIso) / 1000 <= m.date)
    .map((m) => ({ at: m.date * 1000, text: m.message ?? "(media/document)" }))
    .filter((m) => !m.text.startsWith("🤔 Working on it"))
    .sort((a, b) => a.at - b.at);

  // Assign each bot message to the SINGLE turn whose turn.out it is nearest.
  // A fixed window around each turn.out double-counts when two turns complete
  // close together — that put A4's answer under A5 and B5's under C2 on the
  // first attempt. Nearest-wins makes the assignment a partition: every message
  // belongs to exactly one turn, so no reply can be scored twice.
  const completed = results.filter((r) => !r.notRunReason && r.turnId && turnOutAt.has(r.turnId));
  const owned = new Map<string, string[]>();
  for (const m of botMsgs) {
    let bestId = "";
    let bestDelta = Number.POSITIVE_INFINITY;
    for (const r of completed) {
      const delta = Math.abs(m.at - turnOutAt.get(r.turnId)!);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestId = r.turnId;
      }
    }
    // Beyond two minutes from any turn.out it is not this run's traffic.
    if (bestId && bestDelta <= 120_000) owned.set(bestId, [...(owned.get(bestId) ?? []), m.text]);
  }

  const updated = results.map((r) => {
    if (r.notRunReason || !r.turnId) return r;
    if (!turnOutAt.has(r.turnId)) {
      return { ...r, reply: "(prod's journal records no turn.out for this turnId — the turn never completed)" };
    }
    return {
      ...r,
      reply: (owned.get(r.turnId) ?? []).join("\n---\n").trim() || "(no Telegram message found at this turn's completion)",
    };
  });

  writeFileSync(`${outPath}.raw.json`, JSON.stringify(updated, null, 2));
  const withReply = updated.filter((r) => !r.notRunReason && r.reply && !r.reply.startsWith("(")).length;
  console.log(`Re-attributed from turn.out: ${withReply}/${updated.filter((r) => !r.notRunReason).length} tasks now carry their OWN reply`);
}

/** scores.json: { "A1": "intent=1 source=0 completeness=0 artifact=0 delivery=0 truthfulness=1 leakage=1 friction=1" } */
function render(outPath: string, scoresPath: string): void {
  const results = JSON.parse(readFileSync(`${outPath}.raw.json`, "utf8")) as TaskResult[];
  const scores = JSON.parse(readFileSync(scoresPath, "utf8")) as Record<string, string>;
  const today = new Date().toISOString().slice(0, 10);

  const blocks = results.map((r) => {
    if (r.notRunReason) {
      return [
        `### ${r.id}`,
        `- **setup:** ${r.setup ?? r.prompt}`,
        `- NOT RUN — ${r.notRunReason}`,
        "",
      ].join("\n");
    }
    const line = scores[r.id];
    if (!line) throw new Error(`${r.id} ran but has no entry in ${scoresPath} — every executed task must be scored.`);
    const total = [...line.matchAll(/=([01])\b/g)].reduce((acc, m) => acc + Number(m[1]), 0);
    return [
      `### ${r.id}`,
      r.setup ? `- **setup:** ${r.setup}` : "",
      `- **prompt sent:** \`${r.prompt}\``,
      `- **sent at:** ${r.sentAt}`,
      `- **turnId:** ${r.turnId}`,
      "- **reply:**",
      "```text",
      r.reply,
      "```",
      `- **scores:** ${line}`,
      `- **total:** ${total}/8`,
      "",
    ]
      .filter(Boolean)
      .join("\n");
  });

  writeFileSync(
    outPath,
    [
      `# Reality Benchmark — run ${today}`,
      "",
      "Produced by `scripts/run-reality-benchmark.ts`, which sends each prompt through the real",
      "production bot over MTProto and matches every turnId against prod's own journal. Scores are",
      "judgement applied afterwards to the verbatim replies below, never by the process that",
      "produced them.",
      "",
      "Verify with:",
      "",
      "```bash",
      `pnpm verify:benchmark ${outPath}`,
      "```",
      "",
      "---",
      "",
      ...blocks,
    ].join("\n"),
  );
  console.log(`Wrote ${outPath}`);
}

const [mode, outPath, arg] = process.argv.slice(2);
if (mode === "run" && outPath) await runAll(outPath);
else if (mode === "rematch" && outPath && arg) await rematch(outPath, arg);
else if (mode === "reattribute" && outPath && arg) await reattribute(outPath, arg);
else if (mode === "render" && outPath && arg) render(outPath, arg);
else {
  console.error(
    "usage: run-reality-benchmark.ts run <out.md>\n" +
      "       run-reality-benchmark.ts rematch <out.md> <since-iso>\n" +
      "       run-reality-benchmark.ts render <out.md> <scores.json>",
  );
  process.exit(2);
}
