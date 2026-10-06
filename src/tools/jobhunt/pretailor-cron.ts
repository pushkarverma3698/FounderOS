/**
 * FounderOS: the daily pre-tailor cron and its real wiring
 * ========================================================
 * Runs 05:30 in the founder timezone (appTimeZone(): the server is on UTC). The overnight free sweeps have landed by
 * then, the founder looks at the brief around 09:00, and the model calls happen while he is asleep, not on a tap.
 *
 * The rules are in pretailor.ts and are tested with fakes. This file only connects them to the real database, the
 * real tailoring path (buildApplicationPacket, the one the Draft button runs), the real cover-letter writer and the
 * daily budget gate. It sends nothing: no Telegram, email or LinkedIn import lives here (a test checks).
 */

import cron from "node-cron";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ARTIFACT_ROOT, TENANT } from "../../core/config.js";
import { appTimeZone } from "../../core/time.js";
import { getApplicationById, listApplyQueue } from "../../db/apply-queries.js";
import { recordTailoringResult } from "../../db/job-queries.js";
import { getTodayCostUsd, hasBeenAudited, writeAuditEntry } from "../../db/queries.js";
import { assertDailyBudgetAllowsRun, getDailyBudgetCapUsd } from "../../infra/daily-budget.js";
import { childLogger } from "../../infra/logger.js";
import { buildApplicationPacket } from "./apply-packet.js";
import { writeCoverLetter } from "./cover-letter-write.js";
import { listProfiles } from "./profile-config.js";
import { PRETAILOR_ACTION, pretailorRow, runPretailor, type PretailorDeps, type PretailorRowDeps } from "./pretailor.js";
import type { JobApplication } from "../../db/schema.js";

const log = childLogger({ module: "jobhunt:pretailor-cron" });

/** Daily 05:30, evaluated in `appTimeZone()`. */
export const PRETAILOR_CRON = "30 5 * * *";

/** Where the throwaway local PDFs go. The stored copy in S3 is the product; the local file is deleted after. */
const SCRATCH_DIR = path.join(ARTIFACT_ROOT, "pretailor");

function rowDeps(): PretailorRowDeps<JobApplication> {
  return {
    buildPacket: async (row) => {
      const built = await buildApplicationPacket(row, SCRATCH_DIR);
      if (!built.ok) return built;
      await fs.rm(built.packet.pdfPath, { force: true }).catch(() => undefined); // allow-failopen: a leftover scratch file is harmless
      return { ok: true, cvMarkdown: built.packet.cvMarkdown };
    },
    cvStored: async (id) => Boolean((await getApplicationById(id, TENANT))?.tailored_cv_s3_key),
    writeLetter: async (row, cvMarkdown) => {
      const res = await writeCoverLetter(row, cvMarkdown);
      return res.ok ? { ok: true } : res;
    },
    markFailed: async (id, reason) => {
      await recordTailoringResult(id, { tailorStatus: "failed", notes: `pre-tailor: ${reason}`.slice(0, 500) });
    },
  };
}

/** The real dependencies. Exported so a test can see the wiring without running it. */
export function productionPretailorDeps(): PretailorDeps<JobApplication> {
  const perRow = rowDeps();
  return {
    profiles: () => listProfiles(),
    refreshRanks: async (profile) => {
      // The brief build pins brief_section and brief_rank, and the Draft card reads them. Zero model calls.
      const { buildDailyBrief } = await import("./daily-brief.js");
      await buildDailyBrief({ profile });
    },
    listQueue: (profile) => listApplyQueue(profile.tenantId, profile.id),
    budgetAllows: async () => {
      try {
        await assertDailyBudgetAllowsRun(() => getTodayCostUsd(TENANT), getDailyBudgetCapUsd(), (m) => log.warn({ err: m }, "Budget telemetry unavailable"));
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: (err as Error).message };
      }
    },
    alreadyRan: (key) => hasBeenAudited(key),
    recordRun: async (key, profile, summary) => {
      await writeAuditEntry({ tenant_id: profile.tenantId, action: PRETAILOR_ACTION, idempotency_key: key, payload: { profile_id: profile.id, ...summary } });
    },
    tailorRow: (row) => pretailorRow(row, perRow),
    now: () => new Date(),
  };
}

export function startJobhuntPretailorCron(): void {
  const timezone = appTimeZone();
  cron.schedule(
    PRETAILOR_CRON,
    () => {
      runPretailor(productionPretailorDeps()).catch((err) => log.error({ err: (err as Error).message }, "Pre-tailor cron error")); // allow-failopen: a failed morning run must not reach the bot process
    },
    { timezone },
  );
  log.info({ cron: PRETAILOR_CRON, timezone }, "Pre-tailor scheduled (daily, top 3 roles per profile, stops at the daily budget)");
}
