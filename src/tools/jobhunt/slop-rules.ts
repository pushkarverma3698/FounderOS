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

export function findSlop(text: string): SlopViolation[] {
  const violations: SlopViolation[] = [];
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

  // Check for colon reveals (A noun phrase, a colon, then a lowercase dramatic reveal)
  const colonRevealRegex = /[^.!?]+:\s+[a-z][^.!?]+/g;
  const colonMatches = text.match(colonRevealRegex);
  if (colonMatches) {
    // we just flag the presence
    for (const m of colonMatches) {
      violations.push({ rule: "Colon reveal", matchedText: m });
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
