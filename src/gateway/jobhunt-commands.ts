/**
 * FounderOS — /draft and /ask
 * ===========================
 * The two commands that turn the daily job brief into an action.
 *
 * The brief prints "1. Aquablu B.V — Embedded Software Engineer … → /draft 1".
 * Without these handlers that arrow points at nothing: grammy drops unregistered
 * slash commands, and the gateway's text handler returns early on anything
 * starting with "/", so the founder would tap the one control the brief offers
 * and receive complete silence.
 *
 * Resolution is PURE CODE, not a model call. The rank was pinned to a row when
 * the brief rendered, so `/draft 2` can only ever mean the row printed as 2.
 * Asking a model to work out which job "2" meant would be a guess with an
 * application riding on it.
 *
 * Neither command sends anything. They compose an instruction and hand it to the
 * ordinary kernel turn, so drafting an email still stops at the HITL card
 * (ADR-018: the machine never submits an application).
 */

import type { Context } from "grammy";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  getApplicationByBriefRank,
  recordTailoringResult,
  updateApplicationStage,
  type BriefSection,
} from "../db/job-queries.js";
import { blockingGates, parseGates } from "../tools/jobhunt/gates.js";
import { tailorCv } from "../tools/jobhunt/tailor-cv.js";
import { sendCoverLetter } from "./cover-letter-delivery.js";
import { renderCvToPdf } from "../tools/jobhunt/cv-renderer.js";
import { uploadFile } from "../infra/storage/s3-client.js";
import { ARTIFACT_ROOT } from "../core/config.js";
import { threadIdFor } from "./kernel-run.js";
import { childLogger } from "./../infra/logger.js";
import type { JobApplication } from "../db/schema.js";

const log = childLogger({ module: "gateway:jobhunt-commands" });

/** Enough of the posting for a tailored draft; the full body can reach 20k chars. */
const POSTING_EXCERPT_CHARS = 6_000;

/** Below this, a posting's description is too thin to tailor a CV against. */
const MIN_DESCRIPTION_CHARS = 50;

/**
 * Parse the row number out of "/draft 2".
 *
 * Returns null for anything that is not a plain positive integer. "2nd", "two"
 * and "" are all refusals rather than guesses — the cost of picking wrong is a
 * tailored application sent about the wrong company.
 */
export function parseRowArg(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 ? n : null;
}

/**
 * Which sections each command addresses, in the words the brief prints them in.
 *
 * `/draft` spans two since 2026-08-06: DO TODAY and the stretch section share
 * one continuous numbering, because a row flagged only on the years bar needs an
 * APPLICATION, not a question. Naming only the first would tell the founder his
 * row is missing from a section it was never in.
 */
const COMMAND_SECTIONS: Readonly<Record<string, string>> = {
  draft: "DO TODAY / A STRETCH WORTH APPLYING TO",
  applied: "DO TODAY / A STRETCH WORTH APPLYING TO",
  ask: "ONE QUESTION AWAY",
};

/** What to say when the number does not resolve. Never a silent no-op. */
export function unresolvedMessage(command: string, rank: number | null): string {
  if (rank === null) {
    return (
      `Usage: /${command} <number> — the number next to a row in the latest job brief.\n` +
      `Example: /${command} 1`
    );
  }
  return (
    `No row ${rank} in the latest brief's ${COMMAND_SECTIONS[command] ?? "actionable"} ` +
    `section.\n\nThe numbers come from the most recent brief only. Ask me for the job brief to ` +
    `get a current list.`
  );
}

/**
 * The drafting instruction for a row that cleared every gate.
 *
 * The checks are listed WITH their status rather than as one flattened string,
 * because they mean opposite things to a drafter: a passing sponsor check is
 * something the letter can lean on ("you're a recognised sponsor, so the permit
 * side is straightforward"), while an unsettled one is something it must not
 * assert.
 */
export function draftInstruction(row: JobApplication): string {
  const { gates } = parseGates(row);
  const evidence =
    gates.length > 0
      ? gates.map((g) => `- [${g.status.toUpperCase()}] ${g.gate}: ${g.evidence}`).join("\n")
      : `- ${row.salary_evidence ?? "none recorded"}`;

  return (
    `Draft a tailored application for this role. Call read_cv FIRST and lead with the ` +
    `strongest matching technical signal. Do NOT send anything — produce the draft for me to read.\n\n` +
    `Company: ${row.company}\n` +
    `Role: ${row.title}\n` +
    `Permit basis: ${row.route}\n` +
    `${row.url ? `URL: ${row.url}\n` : ""}` +
    `\nScreening checks (only assert what is marked PASS):\n${evidence}\n\n` +
    `Posting:\n${(row.description ?? "").slice(0, POSTING_EXCERPT_CHARS)}`
  );
}

/**
 * The question instruction for a flagged row.
 *
 * ONLY THE UNRESOLVED GATES GO IN. Until 2026-08-01 this pasted the entire
 * `salary_evidence` string — every check, passing ones included — under the
 * heading "What is unresolved". A row whose sponsor and language checks had
 * PASSED handed the model three gates and asked it to write one question about
 * them, so the question came back generic. The founder gets one message to an
 * employer; spending it on a check that already passed wastes it.
 *
 * The passing gates are still supplied, clearly labelled as settled, because
 * they are context for the wording — "you're a recognised sponsor, so my
 * question is only about X" is a better message than one written blind.
 */
export function askInstruction(row: JobApplication): string {
  const { gates, legacy } = parseGates(row);
  const unresolved = blockingGates({ status: "flag", gates });
  const settled = gates.filter((g) => g.status === "pass");

  // A row screened before `gate_json` existed has no per-check status at all, so
  // every check reads as unresolved. Saying that out loud is the difference
  // between a model working from an honest gap and one told three settled checks
  // are open — which is the failure this whole change exists to close.
  const legacyNote = legacy
    ? `\n(This row predates our per-check record, so we cannot tell which of these ` +
      `already passed. Ask about the one that most plausibly blocks an offer.)`
    : "";

  const unresolvedText =
    unresolved.length > 0
      ? unresolved.map((g) => `- ${g.gate}: ${g.evidence}`).join("\n") + legacyNote
      : `- (no per-check record for this row) ${row.salary_evidence ?? "nothing recorded"}`;

  return (
    `Write ONE short, specific question to send this employer. It must resolve the ` +
    `UNRESOLVED check(s) below and nothing else — do not ask about the role in general, ` +
    `and do not ask about anything listed as already settled. ` +
    `Do NOT send it; show me the draft.\n\n` +
    `Company: ${row.company}\n` +
    `Role: ${row.title}\n` +
    `Permit basis under consideration: ${row.route}\n` +
    `${row.url ? `URL: ${row.url}\n` : ""}` +
    `\nUNRESOLVED — this is what the question must settle:\n${unresolvedText}\n` +
    (settled.length > 0
      ? `\nALREADY SETTLED — context only, do NOT ask about these:\n` +
        settled.map((g) => `- ${g.gate}: ${g.evidence}`).join("\n")
      : "")
  );
}

export interface JobhuntCommandDeps {
  /** The normal kernel turn — same path a typed message takes. */
  readonly runKernelText: (ctx: Context, text: string) => Promise<void>;
}

/**
 * Tried in order, and at most one can match: the sections that share a command
 * also share one continuous numbering, pinned by `persistBriefRanks` at render
 * time. A pure lookup on stored (section, rank) pairs — no model, no fuzzy
 * match, and a miss is a refusal rather than a near-miss.
 */
async function resolveBriefRow(
  sections: readonly BriefSection[],
  rank: number,
): Promise<JobApplication | null> {
  for (const section of sections) {
    const row = await getApplicationByBriefRank(section, rank);
    if (row) return row;
  }
  return null;
}

async function handleRowCommand(
  ctx: Context,
  command: "draft" | "ask",
  sections: readonly BriefSection[],
  compose: (row: JobApplication) => string,
  deps: JobhuntCommandDeps,
): Promise<void> {
  const rank = parseRowArg(ctx.match?.toString() ?? "");
  if (rank === null) {
    await ctx.reply(unresolvedMessage(command, null));
    return;
  }

  const row = await resolveBriefRow(sections, rank);
  if (!row) {
    await ctx.reply(unresolvedMessage(command, rank));
    return;
  }

  log.info({ command, rank, company: row.company, id: row.id }, "Brief row command resolved");
  await deps.runKernelText(ctx, compose(row));
}

const DRAFT_SECTIONS: readonly BriefSection[] = ["do_today", "stretch"];

/** Where a tailored CV PDF lands before delivery — mirrors write-artifact.ts's directory convention. */
function tailoredCvPath(ctx: Context, row: JobApplication): { dir: string; path: string } {
  const safeThreadDir = threadIdFor(ctx.chat?.id ?? "unknown").replace(/[^a-zA-Z0-9_.-]/g, "_");
  const companySlug = row.company.toLowerCase().replace(/[^a-z0-9]+/g, "_") || "role";
  const dir = path.join(ARTIFACT_ROOT, safeThreadDir);
  return { dir, path: path.join(dir, `cv-${companySlug}-${row.id.slice(0, 8)}.pdf`) };
}

/**
 * Best-effort durable copy in S3, mirroring `tailor-worker.ts`'s upload shape.
 * Never throws: the PDF is already on disk and about to reach Telegram, and
 * losing the archive copy must not cost the founder the delivery itself.
 */
async function archiveTailoredCv(row: JobApplication, pdfBuffer: Buffer): Promise<void> {
  try {
    const prefix = `ready-applications/${new Date().toISOString().slice(0, 10)}/${row.company.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    const s3Key = await uploadFile(pdfBuffer, "tailored_cv.pdf", row.id, prefix);
    await recordTailoringResult(row.id, { tailorStatus: "tailored", tailoredCvS3Key: s3Key });
  } catch (err) {
    log.warn(
      { id: row.id, company: row.company, err: (err as Error).message },
      "S3 archive of tailored CV failed — Telegram delivery still proceeds",
    );
    await recordTailoringResult(row.id, { tailorStatus: "tailored" }).catch(
      // allow-failopen: this is bookkeeping on top of a delivery that already
      // succeeded or is already underway; losing it must not surface as a failure.
      (err2) => log.warn({ id: row.id, err: (err2 as Error).message }, "tailor_status write failed"),
    );
  }
}

/**
 * Tailor + render a CV PDF for `row`, ready for `deliver_artifact` to send.
 *
 * Failure is a normal, expected outcome here (thin JD, LLM slop that never
 * clears revision, a Playwright crash) — returned as a result, not thrown, so
 * the caller's fallback to a text draft is one `if`, not a try/catch pyramid.
 */
async function buildTailoredPdf(
  ctx: Context,
  row: JobApplication,
): Promise<{ ok: true; path: string; cvMarkdown: string } | { ok: false; reason: string }> {
  if (!row.description || row.description.trim().length < MIN_DESCRIPTION_CHARS) {
    return { ok: false, reason: "this posting has no usable description on file" };
  }

  const tailored = await tailorCv({
    jobDescription: row.description,
    companyName: row.company,
    jobTitle: row.title,
    track: row.track,
  });
  if (!tailored.success || !tailored.tailoredMarkdown) {
    return { ok: false, reason: tailored.error ?? "CV tailoring failed" };
  }

  try {
    await recordTailoringResult(row.id, { tailorStatus: "tailoring" });
    const rendered = await renderCvToPdf(tailored.tailoredMarkdown);
    const { dir, path: pdfPath } = tailoredCvPath(ctx, row);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(pdfPath, rendered.pdfBuffer);
    const stats = await fs.stat(pdfPath);
    if (stats.size === 0) throw new Error("PDF render produced 0 bytes");

    await archiveTailoredCv(row, rendered.pdfBuffer);
    // The tailored markdown, not the base CV, is what the cover letter is
    // written from: it is already aligned to this posting, so the letter and the
    // CV cannot end up emphasising different things about the same person.
    return { ok: true, path: pdfPath, cvMarkdown: tailored.tailoredMarkdown };
  } catch (err) {
    const reason = (err as Error).message;
    await recordTailoringResult(row.id, { tailorStatus: "failed", notes: `PDF render failed: ${reason}` }).catch(
      // allow-failopen: we are already on the failure path and about to fall
      // back to a text draft; losing this status write must not compound it.
      (err2) => log.warn({ id: row.id, err: (err2 as Error).message }, "tailor_status write failed"),
    );
    return { ok: false, reason };
  }
}

/**
 * `/draft N` — write the application for row N of DO TODAY or the stretch section.
 *
 * Both, because both end in an application. A row flagged only on the years bar
 * is not a question for the employer — asking whether "5+ years" is firm invites
 * a pre-emptive rejection on the one gate written as a wish — and before
 * 2026-08-06 those rows had no path to `/draft` at all.
 *
 * Produces a real tailored CV PDF, not just drafted text. Tailoring and
 * rendering happen here, outside the kernel — deterministic-enough work with
 * no side effects — and only the actual SEND goes through a kernel turn, so
 * `deliver_artifact`'s HITL gate still fires exactly as it does for every
 * other outbound file (ADR-018: the machine never sends without a tap).
 */
export async function handleDraft(ctx: Context, deps: JobhuntCommandDeps): Promise<void> {
  const rank = parseRowArg(ctx.match?.toString() ?? "");
  if (rank === null) {
    await ctx.reply(unresolvedMessage("draft", null));
    return;
  }

  const row = await resolveBriefRow(DRAFT_SECTIONS, rank);
  if (!row) {
    await ctx.reply(unresolvedMessage("draft", rank));
    return;
  }

  log.info({ command: "draft", rank, company: row.company, id: row.id }, "Brief row command resolved");
  await ctx.reply(`📝 Tailoring your CV for ${row.company}… this takes 20–40s.`);

  const pdf = await buildTailoredPdf(ctx, row);
  if (!pdf.ok) {
    log.warn({ id: row.id, company: row.company, reason: pdf.reason }, "Tailored-PDF path failed — falling back to text draft");
    await ctx.reply(`⚠ Couldn't build a tailored PDF (${pdf.reason.slice(0, 200)}) — drafting a text application instead.`);
    await deps.runKernelText(ctx, draftInstruction(row));
    return;
  }

  await sendCoverLetter(ctx, row, pdf.cvMarkdown);

  await deps.runKernelText(
    ctx,
    `Call the deliver_artifact tool now with path="${pdf.path}" and caption="Tailored CV — ${row.company} — ${row.title}". ` +
      `Do not do anything else — do not read the file, do not summarize it, do not compose any other message. ` +
      `Just call that one tool with exactly those two arguments.`,
  );
}

/** `/ask N` — write the one question that unblocks row N of ONE QUESTION AWAY. */
export async function handleAsk(ctx: Context, deps: JobhuntCommandDeps): Promise<void> {
  await handleRowCommand(ctx, "ask", ["ask"], askInstruction, deps);
}

/**
 * `/applied N` — mark row N applied and drain it from the queue.
 *
 * A row the founder actually applied to must stop appearing in DO TODAY /
 * ASK / a stretch — `listActionableApplications` filters on `stage =
 * 'screened'`, so moving the stage is what removes it, the same mechanism
 * `/draft` and `/ask` never touch. No kernel turn: this is a plain state
 * change with nothing for a model to compose or approve.
 */
export async function handleApplied(ctx: Context): Promise<void> {
  const rank = parseRowArg(ctx.match?.toString() ?? "");
  if (rank === null) {
    await ctx.reply(unresolvedMessage("applied", null));
    return;
  }

  const row = await resolveBriefRow(DRAFT_SECTIONS, rank);
  if (!row) {
    await ctx.reply(unresolvedMessage("applied", rank));
    return;
  }

  const updated = await updateApplicationStage(row.id, "applied", {
    appliedAt: new Date(),
    clearBriefRank: true,
  });
  if (!updated) {
    await ctx.reply(`Couldn't update ${row.company} — no row with id ${row.id} found. Nothing changed.`);
    return;
  }

  log.info({ command: "applied", rank, company: row.company, id: row.id }, "Application marked applied");
  await ctx.reply(`✅ Marked applied — ${row.company} (${row.title}). It's off today's queue.`);
}
