/**
 * Turicks brand voice validation utilities.
 * Used by critique agents and content validators to enforce brand rules at runtime.
 * Source of truth: ~/.claude/brand-guidelines/TURICKS.md
 */

const BANNED_PHRASES: string[] = [
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
];

const CHANNEL_WORD_LIMITS: Record<string, { min?: number; max: number }> = {
  linkedin: { min: 150, max: 300 },
  instagram: { min: 0, max: 150 },
  outreach: { min: 0, max: 150 },
  proposal: { min: 0, max: 500 },
};

/** Returns true if the text contains any banned phrase (case-insensitive). */
export function containsBannedPhrase(text: string): boolean {
  const lower = text.toLowerCase();
  return BANNED_PHRASES.some((phrase) => lower.includes(phrase));
}

/** Returns the banned phrases found in text, or an empty array. */
export function findBannedPhrases(text: string): string[] {
  const lower = text.toLowerCase();
  return BANNED_PHRASES.filter((phrase) => lower.includes(phrase));
}

/** Counts words in a string. */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Returns true if the text meets the word count requirements for the given channel. */
export function validateChannelLength(channel: string, text: string): boolean {
  const limits = CHANNEL_WORD_LIMITS[channel];
  if (!limits) return true;
  const words = countWords(text);
  if (limits.min !== undefined && words < limits.min) return false;
  if (words > limits.max) return false;
  return true;
}

export interface LinkedInValidationResult {
  valid: boolean;
  violations: string[];
  word_count: number;
  banned_phrases_found: string[];
}

/**
 * Validates a LinkedIn post against Turicks brand rules:
 * - Hook on line 1 (number, question mark, or counterintuitive phrasing)
 * - 150–300 words
 * - No banned phrases
 * - Max 3 emojis
 */
export function validateLinkedInPost(post: string): LinkedInValidationResult {
  const violations: string[] = [];
  const word_count = countWords(post);
  const banned_phrases_found = findBannedPhrases(post);

  // Hook check: line 1 must contain a number, question mark, or be a strong statement
  const firstLine = post.split("\n")[0] ?? "";
  const hasNumber = /\d/.test(firstLine);
  const hasQuestion = firstLine.includes("?");
  if (!hasNumber && !hasQuestion) {
    violations.push("missing_hook");
  }

  // Word count
  if (word_count < 150 || word_count > 300) {
    violations.push("word_count_out_of_range");
  }

  // Banned phrases
  if (banned_phrases_found.length > 0) {
    violations.push("banned_phrase");
  }

  // Emoji limit
  const emojiCount = (post.match(/\p{Emoji}/gu) ?? []).length;
  if (emojiCount > 3) {
    violations.push("too_many_emojis");
  }

  return {
    valid: violations.length === 0,
    violations,
    word_count,
    banned_phrases_found,
  };
}
