/**
 * FounderOS - coding pipeline v2: how a coding ask is filed (AGENT_PIPELINE_V2=1)
 * ================================================================================
 * With the flag on, dispatch_antigravity_task files the issue as `agent:spec`, not `agent:ready`: nothing may build
 * before Pass P writes the contract and the founder approves the spec card. Small pure pieces:
 *  - specIntakeOn: the one reading of the flag for intake (dispatch-antigravity.ts and its agent-tool wrapper both
 *    call it, so the approval card, the filed issue and the reply cannot disagree);
 *  - filedLabels / filedBody: the labels and body execute() files;
 *  - verbatimAskSection: the founder's message stored unmodified, in a fence longer than any backtick run in it so
 *    nothing in the ask can close the fence or become a heading. Pass P reads it as the contract's `ask`; the
 *    dispatcher fences it again as untrusted data;
 *  - specDraftingReply: what the founder reads. It says a spec is being drafted and a card will follow, never
 *    "queued": nothing is queued for execution yet.
 *
 * The dispatch kick is deliberately still written. `agent-dispatch --kicked` runs an ordinary tick (it only logs the
 * note; it does not force the issue), so it cannot claim an `agent:spec` issue for building; it only starts the
 * tick that runs Pass P sooner.
 */

import { LABEL_READY, LABEL_SPEC, pipelineV2Enabled } from "./pipeline-pending.js";

export const VERBATIM_HEADING = "Founder request (verbatim)";

export function specIntakeOn(env: Record<string, string | undefined> = process.env): boolean {
  return pipelineV2Enabled(env);
}

/** The ask to store, or undefined: flag off, or nothing but whitespace was passed. The text itself is never edited. */
export function askForBody(founderRequest: string | undefined | null, on: boolean = specIntakeOn()): string | undefined {
  return on && founderRequest && founderRequest.trim() !== "" ? founderRequest : undefined;
}

/** The ask in a fence at least one backtick longer than any run inside it, under its own heading. */
export function verbatimAskSection(ask: string): string[] {
  const longest = Math.max(0, ...[...ask.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`## ${VERBATIM_HEADING}`, "", `${fence}\n${ask}\n${fence}`, ""];
}

/** The labels to file: with the flag on, agent:ready becomes agent:spec; everything else, and flag off, is untouched. */
export function filedLabels(labels: readonly string[], on: boolean = specIntakeOn()): string[] {
  return labels.map((l) => (on && l === LABEL_READY ? LABEL_SPEC : l));
}

/** The brief as filed: unchanged with the flag off, else the brief plus the founder's verbatim ask when there is one. */
export function filedBody(body: string, founderRequest: string | undefined | null, on: boolean = specIntakeOn()): string {
  const ask = askForBody(founderRequest, on);
  return ask === undefined ? body : [body, "", ...verbatimAskSection(ask)].join("\n").trimEnd();
}

export function specDraftingReply(f: { who: string; issue: number; repo: string; url: string; engineLabel: string }): string {
  return (
    `✅ Filed for ${f.who}: Issue #${f.issue} opened on ${f.repo} with labels '${LABEL_SPEC}' and '${f.engineLabel}'.\n` +
    `URL: ${f.url}\n` +
    "The spec is being drafted from your request as you wrote it. A spec card will follow here in Telegram; " +
    "nothing is built until you approve it."
  );
}
