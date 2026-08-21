/**
 * FounderOS — tailor_cv as a kernel tool
 * =======================================
 * The `UnifiedTool` face of `buildApplicationPacket`, so a plain-English turn
 * ("tailor my CV for row 2", "apply to all of them") lands on exactly the same
 * code `/draft 2` runs.
 *
 * THIS TOOL EXISTS BECAUSE OF A MEASURED FABRICATION. On 2026-08-21 the founder
 * asked the bot to "apply all of them by drafting proper resumes for each job".
 * The jobhunt worker's toolset contained nothing that could produce a document
 * except `write_artifact`, so the model wrote one out of its own context and
 * reported it as tailored resumes — 90 seconds after `read_cv` had failed on the
 * box with ENOENT, meaning those "resumes" were composed with no CV at all.
 *
 * The fix is not a stronger instruction. It is that the only route to a tailored
 * CV now runs through `readFullCvText`, fails loudly when the document cannot be
 * read, and returns a path to a file that exists — a receipt the synthesizer can
 * check (rule #27: a rule with no mechanism decays).
 *
 * NO HITL. Nothing leaves the box: this writes a PDF under ARTIFACT_ROOT. The
 * gate fires on `deliver_artifact`, which is the tool that actually sends it
 * (ADR-018 — the machine never submits an application).
 */

import * as path from "node:path";
import { ARTIFACT_ROOT } from "../../core/config.js";
import { childLogger } from "../../infra/logger.js";
import { buildApplicationPacket, resolveBriefRow } from "./apply-packet.js";
import type { UnifiedTool, ToolResult } from "../index.js";

const log = childLogger({ module: "tool:tailor_cv" });

export const tailorCvTool: UnifiedTool = {
  name: "tailor_cv",
  description:
    "Tailor Pushkar's REAL CV to one screened job posting and render it as an ATS-safe PDF. " +
    "This is the ONLY way to produce a tailored CV — never write one yourself with write_artifact, " +
    "and never describe a resume you have not built with this tool. " +
    "Takes the row number from the latest job brief. Returns the PDF path, the skills that matched, " +
    "and the URL that opens the application form. " +
    "Writes a local file only — call deliver_artifact afterwards to actually send it.",
  input_schema: {
    type: "object",
    properties: {
      rank: {
        type: "number",
        description: "Row number from the latest job brief (the number printed next to the role).",
      },
      thread_id: {
        type: "string",
        description: "Conversation thread — supplied by the kernel, not by the model.",
      },
    },
    required: ["rank"],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const rank = Number(args["rank"]);
    if (!Number.isInteger(rank) || rank < 1) {
      return {
        success: false,
        error: `"${String(args["rank"])}" is not a brief row number. Ask for the job brief first, then pass the number printed next to the role.`,
      };
    }

    const row = await resolveBriefRow(rank);
    if (!row) {
      // A refusal, never a nearest match. The cost of guessing is a tailored
      // application written about the wrong company.
      return {
        success: false,
        error:
          `No row ${rank} in the latest brief's actionable sections. The numbers come from the ` +
          `most recent brief only — call job_brief to get a current list, then try again.`,
      };
    }

    const threadId = String(args["thread_id"] ?? "default").replace(/[^a-zA-Z0-9_.-]/g, "_");
    const built = await buildApplicationPacket(row, path.join(ARTIFACT_ROOT, threadId));
    if (!built.ok) {
      log.warn({ rank, company: row.company, reason: built.reason }, "tailor_cv failed");
      return { success: false, error: `Could not tailor a CV for ${row.company}: ${built.reason}` };
    }

    const { packet } = built;
    const asked = packet.matchedSkills.length + packet.missingSkills.length;
    log.info(
      { rank, company: row.company, matched: packet.matchedSkills.length, asked },
      "tailor_cv produced a packet",
    );

    return {
      success: true,
      data:
        `Tailored CV built for ${row.company} — ${row.title} (brief row ${rank}).\n` +
        `PDF: ${packet.pdfPath}\n` +
        `Matched ${packet.matchedSkills.length}/${asked} of the skills the posting asks for.\n` +
        `Matched: ${packet.matchedSkills.slice(0, 12).join(", ") || "none"}\n` +
        `Not on the CV: ${packet.missingSkills.slice(0, 12).join(", ") || "none"}\n` +
        `Apply here: ${packet.applyUrl || "no URL on file"}` +
        (packet.opensTheForm ? " (opens the form directly)" : " (posting page — the form is behind its own button)") +
        `\n\nNext: call deliver_artifact with that exact path to send it to the founder.`,
    };
  },
};
