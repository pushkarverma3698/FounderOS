/**
 * FounderOS: writing and storing the cover letter
 * ===============================================
 * Moved out of gateway/cover-letter-delivery.ts so the daily pre-tailor step (src/tools/jobhunt/pretailor-cron.ts)
 * and the Draft button write the letter with ONE function. The gateway keeps only the part that talks to Telegram.
 * Nothing here sends: it returns the letter and keeps a copy in S3.
 */

import { recordTailoringResult } from "../../db/job-queries.js";
import { buildCoverLetter, type CoverLetterModel } from "./cover-letter.js";
import { invokeWorkerWithFallbacks } from "../../agents/worker-invoke.js";
import { uploadFile } from "../../infra/storage/s3-client.js";
import { DEFAULT_PROFILE_ID } from "./profile-config.js";
import { childLogger } from "../../infra/logger.js";
import type { JobApplication } from "../../db/schema.js";

const log = childLogger({ module: "jobhunt:cover-letter-write" });

/**
 * True, reusable facts the CV doesn't always carry. Founder's own words,
 * condensed from his 2026-08-24 cover letter draft — not generated.
 *
 * Unrelated to the `founder_context` DB table/`getFounderContext` in
 * db/schema.ts + db/queries.ts (that one is a mutable, agent-writable
 * business-state cache; this is a static, code-authored identity fact).
 *
 * REVIEW BY 2026-11-30: this string asserts the guesthouse closes in
 * November 2026. Past that date it is a false claim sent to real companies —
 * update or remove the guesthouse sentence.
 */
const FOUNDER_CONTEXT =
  "I have been working for myself since February 2026 — I co-founded a small " +
  "engineering studio that has not yet taken on clients, and I ran a " +
  "guesthouse in Himachal Pradesh which I am closing in November 2026. Both " +
  "were real work. I am looking to come back into a team and can start " +
  "immediately. I am relocating to the Netherlands and am eligible for the " +
  "IND highly skilled migrant permit.";

/**
 * The founder's biography goes only into the founder's own letters. A letter
 * drafted for another profile (the wife's, say) goes to a real company, and
 * must not carry his guesthouse, studio or relocation story.
 */
export function founderContextFor(profileId: string): string | undefined {
  return profileId === DEFAULT_PROFILE_ID ? FOUNDER_CONTEXT : undefined;
}


export type CoverLetterOutcome = { readonly ok: true; readonly letter: string } | { readonly ok: false; readonly reason: string };

/**
 * Write the letter from the tailored CV and keep a copy beside the CV in S3 (cover_letter_s3_key).
 * Never throws on a model failure: a provider outage or a draft that could not be cleaned up to the voice rules
 * costs the letter, not the application. The S3 copy is best-effort for the same reason.
 */
export async function writeCoverLetter(row: JobApplication, cvMarkdown: string): Promise<CoverLetterOutcome> {
  // cover-letter.ts is deliberately ignorant of LangChain so its tests cost nothing and run offline.
  // Through the fallback chain, not the bare primary: a Gemini 503 once cost the letter although two
  // working fallbacks were configured (prod, 2026-08-21).
  const model: CoverLetterModel = {
    invoke: (messages) => invokeWorkerWithFallbacks(messages, { attribution: { agent: "jobhunt", stage: "worker" } }),
  };
  const result = await buildCoverLetter(
    {
      companyName: row.company,
      jobTitle: row.title,
      jobDescription: row.description ?? "",
      track: row.track,
      cvText: cvMarkdown,
      founderContext: founderContextFor(row.profile_id),
    },
    model,
  );
  if (!result.success || !result.letter) return { ok: false, reason: result.error ?? "unknown" };
  await archiveCoverLetter(row, result.letter);
  return { ok: true, letter: result.letter };
}

/** `cover_letter_s3_key` is what lets the Draft button return a stored letter instead of paying for a new one. */
async function archiveCoverLetter(row: JobApplication, letter: string): Promise<void> {
  try {
    const prefix = `ready-applications/${new Date().toISOString().slice(0, 10)}/${row.company.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
    const key = await uploadFile(Buffer.from(letter, "utf8"), "cover_letter.txt", row.id, prefix);
    await recordTailoringResult(row.id, { tailorStatus: "tailored", coverLetterS3Key: key });
  } catch (err) {
    // allow-failopen: the letter is already written and about to be returned; losing the archive copy must not cost it.
    log.warn({ id: row.id, company: row.company, err: (err as Error).message }, "S3 archive of the cover letter failed");
  }
}
