/**
 * FounderOS — `job_brief`, the English half of the command surface
 * ================================================================
 * Split out of daily-brief.ts on 2026-09-08, when the B-block scope plumbing
 * pushed that file past its 400-line CI budget — and it belongs apart anyway:
 * daily-brief.ts is about BUILDING a brief, this is about the founder ASKING
 * for one in a sentence.
 *
 * THE PROPERTY THIS FILE OWES. "tashi's last 2 days jobs founded" and
 * `/jobs wife 2d found` must return the same rows. They do not merely agree by
 * inspection: both reduce to a `BriefRequest` through `brief-resolver.ts` and
 * then to the identical `buildDailyBrief` call, so there is no second
 * implementation for the two to drift apart in. The slash handlers
 * (src/gateway/jobhunt-view.ts) do the same, one layer up.
 *
 * The tool takes the planner's SPLIT fields rather than a raw sentence, because
 * that is what a planner is for — but each field still goes through the same
 * primitive the slash parser uses, so an extraction mistake degrades to the
 * verb's default rather than to a different answer.
 */

import { buildDailyBrief } from "./daily-brief.js";
import { briefRequestFromArgs, isProfileMiss, scopeFor, profileMissMessage } from "./brief-resolver.js";
import { getProfile } from "./profile-config.js";
import { lastFreshView, recordFreshView } from "../../db/job-heartbeat-queries.js";
import { childLogger } from "../../infra/logger.js";
import type { UnifiedTool, ToolResult } from "../index.js";

const log = childLogger({ module: "jobhunt:brief-tool" });

export const jobBriefTool: UnifiedTool = {
  name: "job_brief",
  description:
    "Show the ranked job brief: which screened roles to apply to, freshest first, ordered " +
    "within a day by how much of the posting's stack the CV already covers, each verified " +
    "still open. Use when the founder asks what to apply to, what's in the pipeline, what to " +
    "do about jobs, for today's shortlist, or for what has arrived since he last looked. " +
    "Reads what ingest_jobs already screened — it does not fetch. Read-only, no approval " +
    "needed, no model spend.",
  input_schema: {
    type: "object",
    properties: {
      skip_liveness: {
        type: "boolean",
        description:
          "Skip the still-open check. Faster, but rows will read 'couldn't confirm'.",
      },
      profileId: {
        type: "string",
        description:
          "Whose brief to build — a registered profile id (e.g. wife-nl-finance), or the " +
          "name the founder used ('tashi', 'wife', 'me'). Omit for the founder's own brief, " +
          "never a mix of every candidate's rows.",
      },
      verb: {
        type: "string",
        enum: ["jobs", "today", "fresh"],
        description:
          "jobs = everything on file, freshest first (the default). today = only roles the " +
          "employer published in the last 24h. fresh = only what has been discovered since " +
          "the founder last asked for 'fresh'.",
      },
      range: {
        type: "string",
        description:
          "How far back, in the founder's own words: '2d', '48h', '2 days', 'this week'. " +
          "Omit unless he named one. Ignored for verb='today', whose window is fixed at 24h.",
      },
      axis: {
        type: "string",
        enum: ["posted", "found"],
        description:
          "Which date the range applies to. 'posted' = when the employer published it " +
          "(the default). 'found' = when we first stored it — use this when the founder " +
          "says 'found', 'founded' or 'discovered', which is a question about our coverage, " +
          "not about the market.",
      },
    },
    required: [],
  },

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const request = briefRequestFromArgs({
        who: args["profileId"] as string | undefined,
        verb: args["verb"] as string | undefined,
        range: args["range"] as string | undefined,
        axis: args["axis"] as string | undefined,
      });
      if (isProfileMiss(request)) {
        // A refusal, not an error: the founder named a candidate we could not
        // resolve, and drafting against the wrong queue costs an application.
        return { success: true, data: profileMissMessage(request) };
      }

      const profile = getProfile(request.profileId);
      const scope = scopeFor(request, {
        lastFreshView: request.verb === "fresh" ? await lastFreshView(profile.id) : null,
      });
      const now = new Date();

      const brief = await buildDailyBrief({
        ...(args["skip_liveness"] === true ? { skipLiveness: true } : {}),
        profile,
        now,
        scope,
      });

      // AFTER the build, and only for `/fresh`. Stamping before would make a
      // brief that then failed to render still count as "seen", and the rows in
      // it would never appear under `/fresh` again.
      if (request.verb === "fresh") {
        try {
          await recordFreshView(profile.id, now);
        } catch (err) {
          // allow-failopen: the list is the deliverable. A lost marker means the
          // next `/fresh` repeats these rows, which is visible and harmless;
          // failing here would withhold a brief that is already built.
          log.warn({ err: (err as Error).message, profile: profile.id }, "Fresh-view marker not written");
        }
      }

      return { success: true, data: brief };
    } catch (err) {
      return {
        success: false,
        error:
          `Could not build the job brief: ${(err as Error).message}. ` +
          "Nothing was changed — screening results, if any, are still recorded.",
      };
    }
  },
};
