/**
 * Reviewer verdict: the typed answer a PR reviewer must end with.
 *
 * WHY. On PR #861 the reviewer wrote "GATE PASSED" in free text and missed three real bugs. On
 * PR #797 a Gemini reviewer cleared a runbook that told the founder to run an invented command
 * (agy auth login). Free text cannot be validated, so a pass was whatever the prose sounded like.
 *
 * RULES (pure, no I/O, no clock):
 *  - The verdict is the LAST fenced json block of the output, or failing that the last JSON
 *    object in it. A later block overrides an earlier one; an invalid last block is not rescued by
 *    a valid earlier one.
 *  - Unparseable, schema-invalid, or naming a different head than the one reviewed: UNKNOWN, with a
 *    finding that says why. UNKNOWN never becomes APPROVE anywhere downstream.
 *  - APPROVE that carries a blocker finding is contradictory and becomes REQUEST_CHANGES.
 */

import { z } from "zod";

export const ReviewFindingSchema = z.object({
  severity: z.enum(["blocker", "major", "minor"]),
  file: z.string().min(1).max(500).optional(),
  line: z.number().int().positive().optional(),
  claim: z.string().min(1).max(2000),
  evidence: z.string().min(1).max(4000),
});

export const ReviewVerdictSchema = z.object({
  version: z.literal(1),
  head_sha: z.string().min(1).max(64),
  decision: z.enum(["APPROVE", "REQUEST_CHANGES", "UNKNOWN"]),
  findings: z.array(ReviewFindingSchema).max(50),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

/** Prompt fragment: append it to any reviewer prompt. */
export const REVIEW_VERDICT_INSTRUCTIONS = [
  "END YOUR ANSWER with exactly one fenced json block, and nothing after it. Prose is not a verdict.",
  "```json",
  '{"version":1,"head_sha":"<the head sha you were given>","decision":"APPROVE","findings":[',
  '  {"severity":"blocker","file":"path/in/repo","line":12,"claim":"what is wrong","evidence":"the line or output that shows it"}',
  "]}",
  "```",
  "- decision is APPROVE, REQUEST_CHANGES, or UNKNOWN (you could not check something that matters).",
  "- severity is blocker (must not merge), major, or minor. Any blocker means REQUEST_CHANGES.",
  "- Every finding needs a claim and evidence you saw in the diff or in a command you ran. file and line are optional.",
  "- head_sha must be the sha you were given. A different sha makes the verdict UNKNOWN.",
  "- Invalid JSON, or no block, is treated as UNKNOWN: your review is discarded.",
].join("\n");

function unknown(head: string, claim: string, evidence: string, kept: ReviewFinding[] = []): ReviewVerdict {
  return {
    version: 1,
    head_sha: head,
    decision: "UNKNOWN",
    findings: [...kept, { severity: "major", claim, evidence }],
  };
}

/** Body of the last fenced json block, or undefined when there is none. */
function lastFencedJson(text: string): string | undefined {
  const re = /```json[^\S\r\n]*\r?\n([\s\S]*?)```/gi;
  let last: string | undefined;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) last = m[1];
  return last;
}

/** End index (exclusive) of the balanced JSON object starting at `start`, string-aware; -1 if unbalanced. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Last top-level JSON object in free text that parses, as raw text. */
function lastBareObject(text: string): string | undefined {
  let last: string | undefined;
  let i = text.indexOf("{");
  while (i !== -1) {
    const end = objectEnd(text, i);
    if (end === -1) break;
    const slice = text.slice(i, end);
    try {
      JSON.parse(slice);
      last = slice;
      i = text.indexOf("{", end);
    } catch {
      i = text.indexOf("{", i + 1);
    }
  }
  return last;
}

export function parseReviewVerdict(text: string, expectedHead: string): ReviewVerdict {
  const raw = lastFencedJson(text) ?? lastBareObject(text);
  if (raw === undefined) {
    return unknown(expectedHead, "Reviewer output has no JSON verdict block", "No fenced json block and no JSON object found; the answer is discarded, not read as a pass.");
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return unknown(expectedHead, "Reviewer verdict block is not valid JSON", (e as Error).message.slice(0, 300));
  }

  const parsed = ReviewVerdictSchema.safeParse(json);
  if (!parsed.success) {
    const why = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return unknown(expectedHead, "Reviewer verdict does not match the ReviewVerdict schema", why);
  }

  const v = parsed.data;
  if (v.head_sha !== expectedHead) {
    return unknown(
      expectedHead,
      "Reviewer verdict names a different head than the one under review",
      `verdict head_sha ${v.head_sha}, expected ${expectedHead}: the review may describe an older or another commit.`,
      v.findings,
    );
  }

  if (v.decision === "APPROVE" && v.findings.some((f) => f.severity === "blocker")) {
    return {
      ...v,
      decision: "REQUEST_CHANGES",
      findings: [
        ...v.findings,
        { severity: "minor", claim: "Decision coerced from APPROVE to REQUEST_CHANGES", evidence: "The verdict carried a blocker finding; a blocker cannot be approved." },
      ],
    };
  }
  return v;
}
