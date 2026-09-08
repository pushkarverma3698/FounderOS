/**
 * FounderOS — tailor_cv engine
 * =============================
 * Tailors a candidate's base CV to a specific job description.
 *
 * Rules:
 *  1. Zero hallucination — never invents dates, companies, titles, or education.
 *  2. Surgical alignment — reorders bullets and skills to emphasize JD terms.
 *  3. ATS keyword mirroring, bounded by a CLOSED vocabulary — the model may only
 *     name technologies the base CV states (see `permittedTerms` below).
 *  4. Human voice — avoids AI buzzword cliches.
 *
 * WHY THE VOCABULARY IS CLOSED. Until 2026-09-07 this prompt handed the model
 * every skill term the JD mentioned under the heading "JD KEYWORDS TO HIGHLIGHT
 * (ONLY IF TRUTHFUL TO BASE CV)" and left it to sort the truthful ones from the
 * rest. Measured on the real KPN "AI Engineer - Network" row against the real
 * base CV: 11 JD terms went in, and 7 of them (Java, Reinforcement Learning,
 * ETL, System Design, Distributed Systems, A/B Testing, Stakeholder Management)
 * were absent from the CV. Two live `/draft 1` runs wrote two different ones —
 * "Vector Database", then "ETL" — and `verifyCvClaims` blocked both PDFs. In
 * prod that gate had failed 21 of 22 tailoring attempts against 2 applications
 * ever sent, so a prompt inviting fabrication was sitting on the last mile of
 * the entire supply→apply pipeline. The model is now told what it MAY name, not
 * asked to judge what it may not.
 */

import { invokeWorkerWithFallbacks } from "../../agents/worker-invoke.js";
import { childLogger } from "../../infra/logger.js";
import { readFullCvText } from "../career.js";
import { extractSkillTerms } from "./skills.js";
import { overlapScore } from "./overlap.js";
import { findSlop } from "./slop-rules.js";
import { getProfile, type JobSearchProfile } from "./profile-config.js";
import { verifyCvClaims } from "./cv-claim-guard.js";
import { describeClaimViolations } from "./cv-claim-summary.js";

const log = childLogger({ module: "tool:tailor_cv" });

/** Strip a ```markdown fence the model may have wrapped its answer in. */
function stripFences(raw: string): string {
  return raw
    .replace(/^```markdown\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function textOf(response: { content: unknown }): string {
  return typeof response.content === "string" ? response.content : JSON.stringify(response.content);
}

export interface TailorCvOptions {
  readonly cvText?: string;
  readonly jobDescription: string;
  readonly companyName: string;
  readonly jobTitle: string;
  readonly track?: string;
  /**
   * Which candidate profile this tailoring is for. Defaults to Pushkar's
   * profile. Without this, tailoring a CV for Wife's finance roles would read
   * Pushkar's tech CV directory (career.ts CV_DIR/CV_PATH), producing a
   * tailored "CV" built from the wrong person's background.
   */
  readonly profile?: JobSearchProfile;
}

export interface TailorCvResult {
  readonly success: boolean;
  readonly tailoredMarkdown?: string;
  readonly matchedSkills: readonly string[];
  readonly missingSkills: readonly string[];
  readonly initialOverlapRatio: number;
  readonly error?: string;
}

const TAILORING_SYSTEM_PROMPT = `You are an expert technical resume tailoring assistant for a senior engineer.
Your task is to tailor a candidate's base CV specifically for a target Job Description (JD).

CRITICAL CONSTRAINTS (VIOLATING THESE WILL DISQUALIFY THE RESUME):
1. NEVER fabricate or invent job titles, employer names, employment dates, degrees, or certifications.
2. The PERMITTED TECHNOLOGY VOCABULARY below is the COMPLETE set of technologies you may name. Naming anything outside it — even once, even in passing, even because the job description asks for it — disqualifies the resume. A gap the candidate genuinely has is not yours to close.
3. Re-order and re-emphasize the candidate's existing achievements, bullet points, and skills to highlight items most relevant to the JD.
4. Mirror the JD's exact wording ONLY for terms in the permitted vocabulary (e.g. write "React.js" for "React" if the JD does). A JD term that is not in the permitted vocabulary must not appear anywhere in your output.
5. Keep the tone natural, concise, and impact-driven (STAR method with metrics).
6. Output ONLY the complete tailored resume in clean Markdown format with standard ATS section headers:
   # [NAME]
   [Contact Info & Links]
   ## SUMMARY
   ## SKILLS
   ## EXPERIENCE
   ## PROJECTS
   ## EDUCATION (if present in base CV)
`;

export async function tailorCv(opts: TailorCvOptions): Promise<TailorCvResult> {
  const profile = opts.profile ?? getProfile();
  const trackConfig = opts.track ? profile.tracks[opts.track] : undefined;
  const track = opts.track ?? profile.trackPriority[0] ?? "ai";

  let baseCvText = opts.cvText;
  if (!baseCvText) {
    // Explicit per-track CV path (e.g. Wife's mac-client/cv/cv-wife-*.md), then
    // the profile's base CV, then the default track-based lookup. Without this,
    // every profile's tailoring silently read Pushkar's CV_DIR/CV_PATH.
    const explicitPaths = [
      ...(trackConfig?.cvPath ? [trackConfig.cvPath] : []),
      ...(profile.baseCvPath ? [profile.baseCvPath] : []),
    ];
    const fullCv = readFullCvText(track, explicitPaths.length > 0 ? explicitPaths : undefined);
    if (!fullCv.ok) {
      return {
        success: false,
        matchedSkills: [],
        missingSkills: [],
        initialOverlapRatio: 0,
        error: `Failed to load base CV: ${fullCv.error}`,
      };
    }
    baseCvText = fullCv.text;
  }

  const overlap = overlapScore(opts.jobDescription, baseCvText, profile.skillsDictionaryName);

  // The vocabulary the model is allowed to draw on — every technology the base
  // CV actually states, and nothing else. Union of the profile's dictionary and
  // the default tech one because `verifyCvClaims` checks against the tech
  // dictionary regardless of profile: showing Wife's finance CV only its
  // finance terms would judge her tailored CV on a rule it was never given.
  const permittedTerms = [
    ...new Set([
      ...extractSkillTerms(baseCvText, profile.skillsDictionaryName).map((s) => s.term),
      ...extractSkillTerms(baseCvText).map((s) => s.term),
    ]),
  ];

  log.info(
    {
      company: opts.companyName,
      title: opts.jobTitle,
      track,
      asked: overlap.asked,
      matched: overlap.matched.length,
      ratio: overlap.ratio,
    },
    "Tailoring CV for posting",
  );

  const userPrompt = `
TARGET JOB:
Company: ${opts.companyName}
Title: ${opts.jobTitle}

JOB DESCRIPTION:
${opts.jobDescription.slice(0, 12_000)}

MATCHED SKILLS ALREADY ON CV — lead with these:
${overlap.matched.join(", ") || "None"}

PERMITTED TECHNOLOGY VOCABULARY — the ONLY technologies you may name anywhere in the output:
${permittedTerms.join(", ") || "None"}

ASKED FOR BY THE JD BUT NOT ON THIS CV — never write these words, in any section:
${overlap.missing.join(", ") || "None"}

BASE CV:
${baseCvText}

Generate the complete, ATS-tailored Markdown CV now.
`;

  try {
    // NOT `getWorkerModel().invoke` — that is the bare primary with no chain.
    // Prod 2026-08-21: three tailoring attempts died on gemini-flash-latest 503
    // while two configured fallbacks answered on the same key in the same
    // second. See src/agents/worker-invoke.ts.
    const response = await invokeWorkerWithFallbacks(
      [
        { role: "system", content: TAILORING_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      { attribution: { agent: "jobhunt", stage: "worker" } },
    );

    const content = textOf(response);

    // Clean up markdown block tags if the LLM wrapped the output in ```markdown ... ```
    let cleanedMarkdown = stripFences(content);

    let violations = findSlop(cleanedMarkdown);
    if (violations.length > 0) {
      log.warn({ violations: violations.length, company: opts.companyName }, "Slop violations found, requesting one revision");
      
      const revisionPrompt = `Your previous output contained AI cliches or banned patterns.
Please fix the following violations. Do NOT fully rewrite the CV, just fix these specific lines:

${violations.map(v => `- Rule: ${v.rule}\n  Matched text: "${v.matchedText}"`).join("\n\n")}

Output the corrected full Markdown CV.`;

      const revisionResponse = await invokeWorkerWithFallbacks(
        [
          { role: "system", content: TAILORING_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
          { role: "assistant", content: content },
          { role: "user", content: revisionPrompt },
        ],
        { attribution: { agent: "jobhunt", stage: "worker" } },
      );

      cleanedMarkdown = stripFences(textOf(revisionResponse));

      violations = findSlop(cleanedMarkdown);
      if (violations.length > 0) {
        log.error({ violations: violations.length, company: opts.companyName }, "Slop violations persist after revision");
        return {
          success: false,
          matchedSkills: overlap.matched,
          missingSkills: overlap.missing,
          initialOverlapRatio: overlap.ratio,
          error: `CV still contains AI slop after revision: ${violations.map(v => v.matchedText).join(", ")}`
        };
      }
    }

    // The prompt above TELLS the model never to fabricate — a wish, not a
    // guard (CLAUDE.md "Determinism": guards must be pure functions, never
    // prompt instructions). This is the guard: a deterministic, $0 check of
    // every named technology, employer, title, date and degree against the
    // base CV, run AFTER the slop gate so a caught fabrication doesn't waste
    // a revision round on style. See cv-claim-guard.ts for exactly what it
    // does and does not catch.
    let claimCheck = verifyCvClaims(cleanedMarkdown, baseCvText);

    // ONE repair round before refusing — the same shape as the slop revision
    // above, and for the same reason. PROD 2026-09-07: 21 of 22 tailoring
    // attempts ended here, each one throwing away a whole generated CV over a
    // handful of words the model pulled out of the job description. A single
    // targeted round that names the offending claims recovers most of those at
    // the cost of one worker call on a path that was otherwise a total loss.
    //
    // The guard itself is NOT relaxed by this. The repaired CV is re-verified
    // by the same function, and a fabrication that survives the round is still
    // a terminal failure — a guard that passes a fabricated CV is worse than a
    // blocked application.
    if (!claimCheck.ok) {
      log.warn(
        { company: opts.companyName, violations: claimCheck.violations.length },
        "Tailored CV makes ungrounded claims — requesting one repair round",
      );

      const repairPrompt = `${describeClaimViolations(claimCheck.violations)}.

Remove every one of the following from the CV. Do NOT rewrite the rest — keep the same structure, ordering and wording everywhere else:

${claimCheck.violations.map((v) => `- ${v.kind}: "${v.claim}"`).join("\n")}

Where a removal leaves a gap, close it with something the BASE CV already states. Do not substitute a different technology that is also missing from the permitted vocabulary.

Output the corrected full Markdown CV.`;

      const repairResponse = await invokeWorkerWithFallbacks(
        [
          { role: "system", content: TAILORING_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
          { role: "assistant", content: cleanedMarkdown },
          { role: "user", content: repairPrompt },
        ],
        { attribution: { agent: "jobhunt", stage: "worker" } },
      );

      const repaired = stripFences(textOf(repairResponse));
      claimCheck = verifyCvClaims(repaired, baseCvText);

      // Style is re-checked too: the repair rewrites prose, and the slop gate
      // it already passed says nothing about the text that replaced it.
      const repairedSlop = claimCheck.ok ? findSlop(repaired) : [];
      if (repairedSlop.length > 0) {
        log.error(
          { company: opts.companyName, violations: repairedSlop.length },
          "Claim repair reintroduced AI slop",
        );
        return {
          success: false,
          matchedSkills: overlap.matched,
          missingSkills: overlap.missing,
          initialOverlapRatio: overlap.ratio,
          error: `CV repair reintroduced AI slop: ${repairedSlop.map((v) => v.matchedText).join(", ")}`,
        };
      }

      if (claimCheck.ok) cleanedMarkdown = repaired;
    }

    if (!claimCheck.ok) {
      log.error(
        { company: opts.companyName, violations: claimCheck.violations.length },
        "Tailored CV still makes claims the base CV does not support after repair — refusing to send it",
      );
      return {
        success: false,
        matchedSkills: overlap.matched,
        missingSkills: overlap.missing,
        initialOverlapRatio: overlap.ratio,
        error: describeClaimViolations(claimCheck.violations),
      };
    }

    return {
      success: true,
      tailoredMarkdown: cleanedMarkdown,
      matchedSkills: overlap.matched,
      missingSkills: overlap.missing,
      initialOverlapRatio: overlap.ratio,
    };
  } catch (err) {
    const msg = (err as Error).message;
    log.error({ company: opts.companyName, err: msg }, "CV tailoring LLM call failed");
    return {
      success: false,
      matchedSkills: overlap.matched,
      missingSkills: overlap.missing,
      initialOverlapRatio: overlap.ratio,
      error: `LLM invocation failed: ${msg}`,
    };
  }
}
