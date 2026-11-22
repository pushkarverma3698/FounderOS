/**
 * Mac worker packet: everything the Mac needs to apply to one leased row
 * ======================================================================
 * Read-only. The form URL, every answer the bot would have typed (the same rows the hand-off panel shows), the plan
 * the last form scrape recorded, the CV's name and size (the bytes come from GET .../cv), and the audit idempotency
 * key the confirmed result is written under. Nothing here sends anything to an employer.
 */

import * as fs from "node:fs/promises";
import type { JobApplication } from "../db/schema.js";
import { jobsChatId } from "../infra/telegram-send.js";
import { loadApplySnapshot } from "../tools/jobhunt/apply-link.js";
import { getApplyUrl } from "../tools/jobhunt/apply-packet.js";
import { applyProfilePathFor, readApplyProfile } from "../tools/jobhunt/apply-profile.js";
import { readCandidateDossier } from "../tools/jobhunt/candidate-dossier.js";
import { buildHandoffRows, type HandoffRow } from "../tools/jobhunt/handoff-rows.js";
import { getProfile } from "../tools/jobhunt/profile-config.js";
import { artifactDirForChat, resolveResumePdf } from "./apply-material.js";
import { auditKeyFor } from "./apply-submit.js";

export interface MacPacket {
  readonly rowId: string;
  readonly company: string;
  readonly title: string;
  readonly url: string;
  readonly answers: readonly HandoffRow[];
  readonly plan: {
    readonly filledAnswers: readonly { readonly label: string; readonly value: string }[];
    readonly requiredUnanswered: readonly { readonly label: string }[];
  } | null;
  readonly cv: { readonly filename: string; readonly bytes: number };
  readonly auditKey: string;
}

export type PacketOutcome = { readonly ok: true; readonly packet: MacPacket; readonly cvPath: string } | { readonly ok: false; readonly reason: string };

export const targetUrlOf = (row: JobApplication): string => getApplyUrl(row.url ?? "", row.company) ?? row.url ?? "";

/** The resume PDF for a row, or the reason there is none. Shared by the packet and the cv download. */
export async function resolveCv(row: JobApplication): Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string }> {
  const profile = getProfile(row.profile_id);
  const loaded = await readApplyProfile(applyProfilePathFor(profile.id));
  if (!loaded.ok) return { ok: false, reason: "apply profile unreadable" };
  const pdf = await resolveResumePdf(row, profile, loaded.profile, artifactDirForChat(jobsChatId()));
  return pdf.ok ? { ok: true, path: pdf.pdfPath } : { ok: false, reason: pdf.reason };
}

export async function buildMacPacket(row: JobApplication): Promise<PacketOutcome> {
  const profile = getProfile(row.profile_id);
  const loaded = await readApplyProfile(applyProfilePathFor(profile.id));
  if (!loaded.ok) return { ok: false, reason: "apply profile unreadable" };
  const cv = await resolveCv(row);
  if (!cv.ok) return { ok: false, reason: `resume missing: ${cv.reason}` };
  const url = targetUrlOf(row);
  if (!url) return { ok: false, reason: "no form url on the row" };
  const snap = loadApplySnapshot(row.id);
  const dossier = await readCandidateDossier(profile.id);
  const answers = buildHandoffRows(loaded.profile, dossier, snap?.summary.formFields, { company: row.company, title: row.title, url });
  const plan = snap
    ? {
        filledAnswers: snap.summary.filledAnswers.filter((f) => f.fieldType !== "file").map((f) => ({ label: f.label, value: f.value })),
        requiredUnanswered: snap.summary.unanswered.filter((q) => q.required).map((q) => ({ label: q.label })),
      }
    : null;
  const stat = await fs.stat(cv.path);
  const packet: MacPacket = {
    rowId: row.id, company: row.company, title: row.title, url, answers, plan,
    cv: { filename: `cv-${row.id.slice(0, 8)}.pdf`, bytes: stat.size }, auditKey: auditKeyFor(row.id),
  };
  return { ok: true, packet, cvPath: cv.path };
}
