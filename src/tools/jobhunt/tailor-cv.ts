/**
 * FounderOS — tailor_cv engine
 * =============================
 * Tailors a candidate's base CV to a specific job description.
 *
 * Rules:
 *  1. Zero hallucination — never invents dates, companies, titles, or education.
 *  2. Surgical alignment — reorders bullets and skills to emphasize JD terms.
 *  3. ATS keyword mirroring — uses exact technical terms from the JD where truthful.
 *  4. Human voice — avoids AI buzzword cliches.
 */

import { invokeWorkerWithFallbacks } from "../../agents/worker-invoke.js";
import { childLogger } from "../../infra/logger.js";
import { readFullCvText } from "../career.js";
import { extractSkillTerms } from "./skills.js";
import { overlapScore } from "./overlap.js";
import { findSlop } from "./slop-rules.js";

const log = childLogger({ module: "tool:tailor_cv" });

export interface TailorCvOptions {
  readonly cvText?: string;
  readonly jobDescription: string;
  readonly companyName: string;
  readonly jobTitle: string;
  readonly track?: string;
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
2. NEVER claim skills or technologies the candidate has not actually worked with.
3. Re-order and re-emphasize the candidate's existing achievements, bullet points, and skills to highlight items most relevant to the JD.
4. Use exact terminology from the JD for hard skills and frameworks where truthful (e.g. if JD says "React.js", match "React.js").
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
  const track = opts.track ?? "ai";
  
  let baseCvText = opts.cvText;
  if (!baseCvText) {
    const fullCv = readFullCvText(track);
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

  const overlap = overlapScore(opts.jobDescription, baseCvText);
  const askedTerms = extractSkillTerms(opts.jobDescription).map((s) => s.term);

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

MATCHED SKILLS ALREADY ON CV:
${overlap.matched.join(", ") || "None"}

JD KEYWORDS TO HIGHLIGHT (ONLY IF TRUTHFUL TO BASE CV):
${askedTerms.join(", ") || "None"}

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

    const content = typeof response.content === "string" 
      ? response.content 
      : JSON.stringify(response.content);

    // Clean up markdown block tags if the LLM wrapped the output in ```markdown ... ```
    let cleanedMarkdown = content
      .replace(/^```markdown\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

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

      const revContent = typeof revisionResponse.content === "string" 
        ? revisionResponse.content 
        : JSON.stringify(revisionResponse.content);
        
      cleanedMarkdown = revContent
        .replace(/^```markdown\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();
        
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
