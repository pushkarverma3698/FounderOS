/**
 * FounderOS — tailor_worker
 * =========================
 * Background worker that processes untailored job applications,
 * generates tailored Markdown CVs, renders them into ATS-safe PDFs,
 * and uploads them to S3.
 */

import { randomUUID } from "node:crypto";
import { childLogger } from "../../infra/logger.js";
import { uploadFile } from "../../infra/storage/s3-client.js";
import { listUntailoredApplications, recordTailoringResult } from "../../db/job-queries.js";
import { tailorCv } from "./tailor-cv.js";
import { renderCvToPdf } from "./cv-renderer.js";

const log = childLogger({ module: "tool:tailor_worker" });

export interface TailorWorkerOutcome {
  readonly processed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly details: ReadonlyArray<{ id: string; company: string; status: "tailored" | "failed"; error?: string }>;
}

export async function processUntailoredApplications(limit = 10): Promise<TailorWorkerOutcome> {
  const pending = await listUntailoredApplications({ limit });
  if (pending.length === 0) {
    log.debug("No untailored job applications to process");
    return { processed: 0, succeeded: 0, failed: 0, details: [] };
  }

  log.info({ count: pending.length }, "Starting CV tailoring worker batch");

  let succeeded = 0;
  let failed = 0;
  const details: Array<{ id: string; company: string; status: "tailored" | "failed"; error?: string }> = [];

  for (const app of pending) {
    const runId = app.id || randomUUID();
    try {
      await recordTailoringResult(app.id, { tailorStatus: "tailoring" });

      if (!app.description || app.description.trim().length < 50) {
        throw new Error("Job application has thin or missing description");
      }

      const tailorRes = await tailorCv({
        jobDescription: app.description,
        companyName: app.company,
        jobTitle: app.title,
        track: app.track,
      });

      if (!tailorRes.success || !tailorRes.tailoredMarkdown) {
        throw new Error(tailorRes.error ?? "Tailoring LLM returned empty output");
      }

      const renderRes = await renderCvToPdf(tailorRes.tailoredMarkdown);

      const dateStr = new Date().toISOString().slice(0, 10);
      const companySlug = app.company.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const prefix = `ready-applications/${dateStr}/${companySlug}`;

      const s3Key = await uploadFile(
        renderRes.pdfBuffer,
        "tailored_cv.pdf",
        runId,
        prefix,
      );

      await recordTailoringResult(app.id, {
        tailorStatus: "tailored",
        tailoredCvS3Key: s3Key,
      });

      succeeded++;
      details.push({ id: app.id, company: app.company, status: "tailored" });
      log.info({ id: app.id, company: app.company, s3Key }, "CV tailored & uploaded successfully");
    } catch (err) {
      failed++;
      const msg = (err as Error).message;
      log.error({ id: app.id, company: app.company, err: msg }, "Failed to process untailored application");
      await recordTailoringResult(app.id, {
        tailorStatus: "failed",
        notes: `Tailoring failed: ${msg}`,
      });
      details.push({ id: app.id, company: app.company, status: "failed", error: msg });
    }
  }

  return { processed: pending.length, succeeded, failed, details };
}
