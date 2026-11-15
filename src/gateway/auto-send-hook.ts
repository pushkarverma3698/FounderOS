/**
 * The auto-send half of the shadow pass, wired from the composition root (src/jobs/scheduler.ts).
 * The shadow pass lives in src/tools and may not import src/gateway, so it receives this hook as a dependency.
 */

import { loadAutoSendHistory } from "../db/job-auto-send-queries.js";
import { readRuntimeSwitch } from "../tools/jobhunt/auto-send-switch.js";
import type { ShadowDeps } from "../tools/jobhunt/shadow-apply.js";
import { runAutoSend } from "./apply-auto-send.js";

export function realAutoSendHook(): NonNullable<ShadowDeps["autoSend"]> {
  return {
    runtimeOn: readRuntimeSwitch,
    history: loadAutoSendHistory,
    send: (row, profileId, summary) => runAutoSend(row, profileId, summary),
  };
}
