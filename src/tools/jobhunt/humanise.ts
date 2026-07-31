/**
 * AI-tell detector
 * ================
 * Every cover letter and post this machine produces is drafted by a model. In the
 * current market a recruiter who recognises LLM prose discards the application, so
 * a draft that reads as generated is strictly worse than sending nothing.
 *
 * The detector is DETERMINISTIC by design. Asking a model "does this sound like a
 * model wrote it?" is the same self-assessment failure the kernel refuses
 * everywhere else — and it is the identical argument as the benchmark scorer:
 * the grader must not be able to hallucinate.
 *
 * DELIBERATELY NOT DETECTED: em-dash density, sentence-length variance, and
 * paragraph uniformity. All three fire heavily on good human technical writing,
 * and a gate with false positives on genuine prose would push drafts toward
 * blandness — the opposite of the goal.
 */

export type TellCategory = "vocabulary" | "opener" | "construction" | "closer" | "hype";

export interface AiTell {
  /** Stable identifier for the specific tell, e.g. "delve". */
  readonly tell: string;
  readonly category: TellCategory;
  /** The surrounding text, so a human can see and fix it. */
  readonly excerpt: string;
}

/** More than this many tells per 100 words and the draft is blocked. */
export const TELL_THRESHOLD = 1.0;

/** Stems flagged wherever they appear. Chosen for near-zero use in plain technical prose. */
const VOCABULARY_STEMS = [
  "delve",
  "leverage",
  "testament",
  "robust",
  "seamless",
  "meticulous",
  "pivotal",
  "tapestry",
  "realm",
  "landscape",
  "elevate",
  "transformative",
  "thrilled",
  "supercharge",
  "holistic",
  "synergy",
  "paradigm",
  "embark",
  "unlock",
] as const;

/** Multi-word tells, matched as phrases. */
const PHRASE_TELLS: ReadonlyArray<{
  tell: string;
  category: TellCategory;
  pattern: RegExp;
}> = [
  { tell: "cutting-edge", category: "vocabulary", pattern: /\bcutting[- ]edge\b/i },
  { tell: "fast-paced", category: "vocabulary", pattern: /\bfast[- ]paced\b/i },
  { tell: "game-changer", category: "hype", pattern: /\bgame[- ]chang(?:er|ing)\b/i },
  { tell: "excited-to-share", category: "opener", pattern: /\b(?:i am|i'm)\s+(?:thrilled|excited|delighted|pleased)\s+to\b/i },
  { tell: "in-todays-landscape", category: "opener", pattern: /\bin today's\s+\w+[- ]?\w*\s+(?:world|landscape|market|era)\b/i },
  { tell: "not-just-but", category: "construction", pattern: /\b(?:isn't|is not|not)\s+just\b[^.!?]{0,60}?\b(?:it's|it is|but)\b/i },
  { tell: "at-the-end-of-the-day", category: "closer", pattern: /\bat the end of the day\b/i },
  { tell: "in-conclusion", category: "closer", pattern: /\bin conclusion\b/i },
  { tell: "the-bottom-line", category: "closer", pattern: /\bthe bottom line\b/i },
];

function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 25);
  const end = Math.min(text.length, index + length + 25);
  return text.slice(start, end).replace(/\s+/g, " ").trim();
}

/** Every AI tell in the text, with the surrounding excerpt for each. */
export function detectAiTells(text: string): AiTell[] {
  const tells: AiTell[] = [];

  for (const stem of VOCABULARY_STEMS) {
    const pattern = new RegExp(`\\b${stem}\\w*\\b`, "gi");
    for (const m of text.matchAll(pattern)) {
      tells.push({
        tell: stem,
        category: "vocabulary",
        excerpt: excerptAround(text, m.index, m[0].length),
      });
    }
  }

  for (const { tell, category, pattern } of PHRASE_TELLS) {
    const m = pattern.exec(text);
    if (m) {
      tells.push({ tell, category, excerpt: excerptAround(text, m.index, m[0].length) });
    }
  }

  return tells;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Tells per 100 words — length-normalised so long documents are not penalised. */
export function aiTellScore(text: string): number {
  const words = wordCount(text);
  if (words === 0) return 0;
  return (detectAiTells(text).length / words) * 100;
}

/** Whether the draft must be rewritten before it reaches the approval queue. */
export function needsHumanising(text: string): boolean {
  return aiTellScore(text) > TELL_THRESHOLD;
}

/**
 * Instruction appended to a rewrite request when a draft fails the gate.
 * Names the specific tells rather than asking vaguely for "a human tone", because
 * a vague instruction produces prose that is bland instead of prose that is specific.
 */
export function humaniseInstruction(text: string): string {
  const tells = detectAiTells(text);
  if (tells.length === 0) return "";

  const unique = [...new Set(tells.map((t) => t.tell))];
  return [
    `Rewrite this so it does not read as model-generated. Detected tells: ${unique.join(", ")}.`,
    "Rules: delete every flagged word rather than swapping in a synonym; keep concrete",
    "nouns, real numbers and specific system names; prefer a short flat sentence to a",
    "balanced one; do not open by announcing enthusiasm; do not close with a summary.",
    "State what happened and what it cost. Never add a fact that is not already present.",
  ].join(" ");
}
