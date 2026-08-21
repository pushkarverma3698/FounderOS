export interface SlopViolation {
  rule: string;
  matchedText: string;
}

const BANNED_WORDS = [
  "delve", "foster", "leverage", "utilize", "facilitate", "empower", "streamline", 
  "robust", "cutting-edge", "paradigm shift", "game changer", "this is huge", 
  "this changes everything", "tapestry", "realm", "beacon", "multifaceted", 
  "meticulous", "intricate", "paramount", "transformative", "elevate", "embark", 
  "supercharge", "harness", "ever-evolving"
];

const BANNED_PHRASES = [
  "it's worth noting", "it's important to note", "at the end of the day", 
  "when it comes to", "at its core", "in today's world", "in the age of", 
  "in the world of", "the reality is", "the truth is", "in terms of", 
  "with regard to", "in order to", "going forward", "in this article", "let's dive in"
];

/**
 * Prose-only patterns, from the `no-ai-slop` skill.
 *
 * OPT-IN, AND THAT IS THE WHOLE DESIGN. These rules are correct for a cover
 * letter and wrong for a CV. The em-dash rule alone would reject all four of
 * the founder's CVs, which write every section as
 * "**Backend & Data** — Node.js, TypeScript, …". A CV is headings, bullets and
 * noun phrases; a letter is prose, and only prose can have a throat-clearing
 * opener or a paragraph that recaps itself.
 */
export interface SlopOptions {
  /** Enable the prose rules. Off by default so the CV path is unaffected. */
  readonly prose?: boolean;
}

/** "This is not X. It's Y." — state Y and stop. */
const BINARY_CONTRAST =
  /\b(?:it'?s|this is|that'?s|the question is)\s+not\s+(?:just\s+)?[^.!?\n]{3,60}[.!?]\s+(?:it'?s|its|but)\b/i;

const THROAT_CLEARING = [
  "here's the thing",
  "here is the thing",
  "here's what i mean",
  "let me be clear",
  "i'll be honest",
  "the uncomfortable truth is",
  "what if i told you",
];

const IMPORTANCE_PUFFERY = [
  "stands as a testament",
  "marks a pivotal moment",
  "plays a vital role",
  "plays a crucial role",
  "solidifies its position",
  "underscores its significance",
  "speaks volumes",
];

const WEASEL_ATTRIBUTION = [
  "experts agree",
  "industry reports suggest",
  "many argue",
  "widely regarded as",
  "studies show",
  "research shows",
];

/** A closing paragraph that restates a letter the reader has just read. */
const SUMMARY_RECAP = /^\s*(?:in conclusion|ultimately|overall|in summary|to summarize|to sum up)\b/im;

function findProseSlop(text: string): SlopViolation[] {
  const violations: SlopViolation[] = [];
  const lower = text.toLowerCase();

  // Em dash. In short copy the skill's guidance is none at all, and a cover
  // letter is short copy — a comma, a full stop or a pair of parentheses says
  // the same thing without the borrowed cadence.
  const emDash = /—/.exec(text);
  if (emDash) {
    violations.push({
      rule: "Em dash",
      matchedText: text.slice(Math.max(0, emDash.index - 25), emDash.index + 25).trim(),
    });
  }

  const binary = BINARY_CONTRAST.exec(text);
  if (binary) violations.push({ rule: "Binary contrast", matchedText: binary[0] });

  const phraseRules: readonly (readonly [string, readonly string[]])[] = [
    ["Throat-clearing opener", THROAT_CLEARING],
    ["Importance puffery", IMPORTANCE_PUFFERY],
    ["Weasel attribution", WEASEL_ATTRIBUTION],
  ];
  for (const [rule, phrases] of phraseRules) {
    for (const phrase of phrases) {
      const index = lower.indexOf(phrase);
      if (index !== -1) {
        violations.push({ rule, matchedText: text.substring(index, index + phrase.length) });
      }
    }
  }

  const recap = SUMMARY_RECAP.exec(text);
  if (recap) violations.push({ rule: "Summary-recap ending", matchedText: recap[0].trim() });

  return violations;
}

export function findSlop(text: string, options: SlopOptions = {}): SlopViolation[] {
  const violations: SlopViolation[] = options.prose ? findProseSlop(text) : [];
  const lowerText = text.toLowerCase();

  for (const word of BANNED_WORDS) {
    // Basic word boundary check
    const regex = new RegExp(`\\b${word}\\b`, "i");
    const match = text.match(regex);
    if (match) {
      violations.push({ rule: "Banned word", matchedText: match[0] });
    }
  }

  for (const phrase of BANNED_PHRASES) {
    if (lowerText.includes(phrase)) {
      // get original case
      const index = lowerText.indexOf(phrase);
      violations.push({ rule: "Empty phrase", matchedText: text.substring(index, index + phrase.length) });
    }
  }

  // Check for colon reveals (a noun phrase, a colon, then a lowercase dramatic
  // reveal) — e.g. "The real secret: nobody tells you this." Scoped to a
  // single line and skipped for markdown list/header lines, because those
  // carry structured CV content ("- Languages: typescript, python, go") that
  // this pattern would otherwise misfire on.
  const colonRevealRegex = /^[^\n:]{15,}:\s+[a-z][^\n.!?]{15,}[.!?]/;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (/^([-*•]|\d+[.)]|#)/.test(trimmed)) continue;
    const match = trimmed.match(colonRevealRegex);
    if (match) {
      violations.push({ rule: "Colon reveal", matchedText: match[0] });
    }
  }

  // Check for faux-insight setups
  const setups = ["this is the part most people skip", "what most people get wrong", "here's what nobody tells you", "the part everyone misses"];
  for (const setup of setups) {
    if (lowerText.includes(setup)) {
      const index = lowerText.indexOf(setup);
      violations.push({ rule: "Faux-insight setup", matchedText: text.substring(index, index + setup.length) });
    }
  }

  return violations;
}
