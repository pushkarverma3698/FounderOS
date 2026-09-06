// src/tools/b2b/rule-extractor.ts
import type { SerperOrganicResult } from "./serper-client";

const RECRUITER_KEYWORD_RE =
  /recruiter|talent acquisition|hr business partner|human resources|people operations|hiring manager/i;

// Checked in order — first match wins. This lets you tell a Technical
// Recruiter from a generic HR Manager when a company has both indexed,
// instead of just noting "some title matched."
export const TITLE_PRIORITY = [
  "technical recruiter",
  "talent acquisition",
  "recruiter",
  "hr business partner",
  "people operations",
  "human resources",
];

export interface ExtractedCandidate {
  name: string;
  title: string | null;
  linkedinUrl: string;
  confidence: number;
  method: "url-slug" | "title-parse" | "llm-batch";
  evidence: string[];
}

export function parseNameFromUrl(url: string): string | null {
  const match = url.match(/linkedin\.com\/in\/([a-z0-9-]+)/i);
  if (!match) return null;

  const parts = match[1]
    .replace(/-\d+$/, "") // drop the trailing numeric id, e.g. "-123456"
    .split("-")
    .filter((part) => part.length > 0 && !/^\d+$/.test(part));

  if (parts.length < 2) return null; // too little to be confident it's a real name

  return parts.map((p) => p[0].toUpperCase() + p.slice(1)).join(" ");
}

export function parseTitleFromText(title: string, snippet: string | undefined): string | null {
  const combined = `${title} ${snippet ?? ""}`.toLowerCase();
  return TITLE_PRIORITY.find((t) => combined.includes(t)) ?? null;
}

export function companyMatches(text: string, cleanCompanyName: string): boolean {
  return text.toLowerCase().includes(cleanCompanyName.toLowerCase());
}

// Deterministic scoring — no model call. Weights are tunable; what matters
// is that they're fixed and auditable, not "the LLM felt 0.8 confident."
export function scoreCandidate(
  result: SerperOrganicResult,
  cleanCompanyName: string
): ExtractedCandidate | null {
  const name = parseNameFromUrl(result.link);
  if (!name) return null; // no name, no candidate

  const evidence: string[] = ["name parsed from LinkedIn URL slug"];
  let confidence = 0.6;

  const title = parseTitleFromText(result.title, result.snippet);
  if (title) {
    confidence += 0.2;
    evidence.push(`title matched "${title}"`);
  }

  const combinedText = `${result.title} ${result.snippet ?? ""}`;
  if (companyMatches(combinedText, cleanCompanyName)) {
    confidence += 0.2;
    evidence.push(`company name "${cleanCompanyName}" found in result text`);
  }

  if (RECRUITER_KEYWORD_RE.test(combinedText)) {
    confidence += 0.1;
    evidence.push("recruiting-related keyword present");
  }

  return {
    name,
    title,
    linkedinUrl: result.link,
    confidence: Math.min(confidence, 1.0),
    method: title ? "title-parse" : "url-slug",
    evidence,
  };
}
