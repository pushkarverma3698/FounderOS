/**
 * FounderOS — tailor_cv engine
 * =============================
 * Tailors a candidate's base CV to a specific job description.
 *
 * Rules:
 *  1. The BASE CV IS LOCKED. Everything below the summary heading is pasted in
 *     byte for byte by cv-compose.ts. The model writes one paragraph.
 *  2. Zero hallucination — never invents dates, companies, titles, or education.
 *  3. ATS keyword mirroring, bounded by a CLOSED vocabulary — the model may only
 *     name technologies the base CV states (see `permittedTerms` below).
 *  4. Human voice — avoids AI buzzword cliches.
 *
 * WHY THE BODY IS LOCKED (founder direction, 2026-09-15: "the Base CV is
 * locked"). Until then this asked for the complete document per posting, so two
 * runs against one posting produced two different CVs and a single ungrounded
 * word discarded the whole result. See cv-compose.ts for the measurements.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: close the keyword gap. `overlap.missing`
 * is reported, never written. A term the CV does not state is either a wording
 * gap or a real one, and only the candidate can say which — `cv_gaps` ranks them
 * for that decision, and the answer goes into the base CV, not into a prompt.
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
import { composeCv, splitCv } from "./cv-compose.js";
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

/**
 * The model writes the SUMMARY. It does not write the CV.
 *
 * Until 2026-09-15 this prompt asked for the complete document every time, and
 * the base CV was only "locked" in the sense that a post-hoc guard checked its
 * technologies and dates. Everything else — every bullet, every clause, the
 * ordering — was regenerated per posting, and a single ungrounded word threw the
 * whole result away (21 of 22 attempts in prod, against 2 applications sent).
 *
 * Asking for three lines instead makes the blast radius three lines. The body is
 * pasted verbatim by cv-compose.ts, so an experience section cannot drift, and
 * `verifyCvClaims` below can only ever fail on the paragraph that is cheapest to
 * regenerate.
 */
const SUMMARY_SYSTEM_PROMPT = `You are rewriting ONE paragraph: the summary at the top of a candidate's CV, aimed at a specific job description.

You are NOT rewriting the CV. The rest of the document is fixed and will be pasted in below your paragraph unchanged. Do not output it.

CRITICAL CONSTRAINTS (violating these disqualifies the application):
1. NEVER state a job title, employer, date, degree or certification the base CV does not state.
2. The PERMITTED TECHNOLOGY VOCABULARY is the COMPLETE set of technologies you may name. Naming anything outside it — even once, even in passing, even because the job description asks for it — disqualifies the resume. A gap the candidate genuinely has is not yours to close.
3. Mirror the job description's exact wording ONLY for terms in the permitted vocabulary (write "React.js" for "React" if the ad does).
4. Lead with the matched skills listed below — those are the overlap a recruiter is scanning for.
5. Plain, specific, first-person-implied prose. No buzzwords, no "passionate", no "proven track record", no em-dash-joined clause pairs.

OUTPUT: the summary paragraph only. 2-4 sentences, at most 70 words. No heading, no markdown fences, no commentary.`;

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

  // Split BEFORE spending a model call. A CV with no summary section is a
  // fixable fact about a file the founder owns, and finding out after the call
  // would bill him for the discovery.
  const parts = splitCv(baseCvText);
  if (!parts.ok) {
    log.error({ company: opts.companyName, reason: parts.error }, "Base CV cannot be split");
    return {
      success: false,
      matchedSkills: overlap.matched,
      missingSkills: overlap.missing,
      initialOverlapRatio: overlap.ratio,
      error: `Base CV is not tailorable: ${parts.error}`,
    };
  }

  const userPrompt = `
TARGET JOB:
Company: ${opts.companyName}
Title: ${opts.jobTitle}

JOB DESCRIPTION:
${opts.jobDescription.slice(0, 12_000)}

MATCHED SKILLS ALREADY ON CV — lead with these:
${overlap.matched.join(", ") || "None"}

PERMITTED TECHNOLOGY VOCABULARY — the ONLY technologies you may name:
${permittedTerms.join(", ") || "None"}

ASKED FOR BY THE JD BUT NOT ON THIS CV — never write these words:
${overlap.missing.join(", ") || "None"}

THE CANDIDATE'S FULL CV, for context. Everything below the summary is FIXED and
will be pasted in unchanged. Read it so your paragraph is true; do not reproduce it:
${baseCvText}

THE CURRENT SUMMARY YOU ARE REPLACING:
${parts.summary.trim()}

Write the replacement summary paragraph now.
`;

  try {
    // NOT `getWorkerModel().invoke` — that is the bare primary with no chain.
    // Prod 2026-08-21: three tailoring attempts died on gemini-flash-latest 503
    // while two configured fallbacks answered on the same key in the same
    // second. See src/agents/worker-invoke.ts.
    const response = await invokeWorkerWithFallbacks(
      [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      { attribution: { agent: "jobhunt", stage: "worker" } },
    );

    const content = textOf(response);

    // The model returns a PARAGRAPH; the document is built here, in code, with
    // the body pasted verbatim. Every check below therefore runs against the
    // real CV the founder would send, not against the fragment.
    let summary = stripFences(content);
    let cleanedMarkdown = composeCv(parts, summary);

    /** One more summary, given a named problem. The body is never resent. */
    const rewriteSummary = async (instruction: string): Promise<string> => {
      const retry = await invokeWorkerWithFallbacks(
        [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
          { role: "assistant", content: summary },
          { role: "user", content: instruction },
        ],
        { attribution: { agent: "jobhunt", stage: "worker" } },
      );
      return stripFences(textOf(retry));
    };

    let violations = findSlop(cleanedMarkdown);
    if (violations.length > 0) {
      log.warn({ violations: violations.length, company: opts.companyName }, "Slop violations found, requesting one revision");

      summary = await rewriteSummary(
        `Your summary contained AI cliches or banned patterns. Rewrite it, keeping the same facts:

${violations.map((v) => `- Rule: ${v.rule}\n  Matched text: "${v.matchedText}"`).join("\n\n")}

Output the corrected summary paragraph only.`,
      );
      cleanedMarkdown = composeCv(parts, summary);

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
    // handful of words the model pulled out of the job description.
    //
    // Since 2026-09-15 a violation can only come from the SUMMARY — the body is
    // pasted verbatim from the base CV, so anything it names is grounded by
    // construction — and the repair regenerates that paragraph alone.
    //
    // The guard itself is NOT relaxed by this. The repaired CV is re-verified by
    // the same function, and a fabrication that survives the round is still a
    // terminal failure — a guard that passes a fabricated CV is worse than a
    // blocked application.
    if (!claimCheck.ok) {
      log.warn(
        { company: opts.companyName, violations: claimCheck.violations.length },
        "Tailored CV makes ungrounded claims — requesting one repair round",
      );

      const repairedSummary = await rewriteSummary(
        `${describeClaimViolations(claimCheck.violations)}.

Remove every one of the following from your summary:

${claimCheck.violations.map((v) => `- ${v.kind}: "${v.claim}"`).join("\n")}

Where a removal leaves a gap, close it with something the BASE CV already states. Do not substitute a different technology that is also missing from the permitted vocabulary.

Output the corrected summary paragraph only.`,
      );

      const repaired = composeCv(parts, repairedSummary);
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
