/**
 * FounderOS — Brand Voice Validator
 * ===================================
 * Deterministic runtime check on generated content BEFORE calling interrupt().
 * If violations are found the tool returns an error string → agent self-corrects
 * → rewrites → calls the tool again. The HITL card only ever shows clean content.
 *
 * Source of truth: ~/.claude/brand-guidelines/TURICKS.md (22 banned phrases).
 * Re-implements v1 src/core/brand.ts with full phrase coverage (v2 prompts had
 * only 10 of the 22 phrases).
 *
 * Pure functions — no I/O, no imports from src/. Easy to unit-test.
 */

// ── Banned phrases ─────────────────────────────────────────────────────────────
// All 22 from ~/.claude/brand-guidelines/TURICKS.md + v1 brand.ts

export const BANNED_PHRASES: readonly string[] = [
  "excited to share",
  "game-changer",
  "game changer",
  "synergy",
  "circle back",
  "excited to announce",
  "thrilled to share",
  "innovative solution",
  "i wanted to reach out",
  "hope this finds you well",
  "just following up",
  "quick question",
  "touch base",
  "we help companies like yours",
  "disruptive",
  "bleeding edge",
  "leverage",
  "paradigm shift",
  "scalable solution",
  "deep dive",
  "move the needle",
  "low-hanging fruit",
] as const;

// ── Channel word limits ────────────────────────────────────────────────────────

const WORD_LIMITS: Record<Channel, { min: number; max: number } | null> = {
  linkedin: { min: 150, max: 300 },
  outreach: { min: 0, max: 150 },
  general: null, // no word limit
};

// ── Types ─────────────────────────────────────────────────────────────────────

export type Channel = "linkedin" | "outreach" | "general";

export interface BrandValidationResult {
  valid: boolean;
  /** Human-readable violation strings, e.g. "found banned phrase: 'game-changer'" */
  violations: string[];
}

// ── Core validator ─────────────────────────────────────────────────────────────

/**
 * Validate generated content against Turicks brand voice rules.
 *
 * @param text    The content to validate (LinkedIn post body, email body, etc.)
 * @param channel The output channel — controls word-limit + channel-specific rules
 */
export function validateBrandVoice(text: string, channel: Channel): BrandValidationResult {
  const violations: string[] = [];
  const lower = text.toLowerCase();

  // 1. Banned phrases (all channels)
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase.toLowerCase())) {
      violations.push(`found banned phrase: '${phrase}'`);
    }
  }

  // 2. Word count limits
  const wordCount = countWords(text);
  const limits = WORD_LIMITS[channel];
  if (limits !== null) {
    if (wordCount < limits.min) {
      violations.push(
        `word count too low: ${wordCount} words (${channel} requires ${limits.min}–${limits.max})`,
      );
    } else if (wordCount > limits.max) {
      violations.push(
        `word count too high: ${wordCount} words (${channel} requires ${limits.min}–${limits.max})`,
      );
    }
  }

  // 3. LinkedIn-specific rules
  if (channel === "linkedin") {
    // Hook: line 1 must contain a digit OR a '?'
    const firstLine = text.split("\n")[0]?.trim() ?? "";
    if (!/\d|\?/.test(firstLine)) {
      violations.push(
        `missing hook on line 1: first line must contain a number or '?' (got: "${firstLine.slice(0, 60)}")`,
      );
    }

    // Emoji count: max 3
    const emojiCount = countEmojis(text);
    if (emojiCount > 3) {
      violations.push(`too many emojis: ${emojiCount} (max 3 for LinkedIn)`);
    }
  }

  return { valid: violations.length === 0, violations };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function countEmojis(text: string): number {
  // Match Unicode emoji sequences (basic + ZWJ sequences + modifiers)
  const matches = text.match(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu);
  return matches?.length ?? 0;
}
