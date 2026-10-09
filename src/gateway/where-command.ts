/**
 * FounderOS — /where
 * ==================
 * Done / in flight / left / blocked per repo, straight from GitHub. No LLM, no DB.
 * `/where` = every dispatch repo; `/where <repo>` = one. (`/status` stays system health.)
 */

import type { Context } from "grammy";
import { DISPATCH_REPO_ALLOWLIST } from "../tools/dispatch-repos.js";
import { fetchRepoStatus, resolveRepoArg, type RepoStatusView } from "../tools/repo-status.js";
import { renderWhere } from "../tools/repo-status-render.js";
import { splitForTelegram } from "./format.js";
import { fetchCaptureStatus, renderCaptureLine, type CaptureStatus } from "../db/brain-capture-status.js";
import { appTimeZone } from "../core/time.js";

export interface WhereDeps {
  readonly fetch: (repos: readonly string[]) => Promise<RepoStatusView>;
  /** Mac capture heartbeat (AG-027). Omitted = no line. */
  readonly capture?: () => Promise<CaptureStatus>;
}

export async function handleWhere(
  ctx: Context,
  deps: WhereDeps = { fetch: (repos) => fetchRepoStatus(repos), capture: () => fetchCaptureStatus(appTimeZone()) },
): Promise<void> {
  const arg = typeof ctx.match === "string" ? ctx.match : "";
  const resolved = resolveRepoArg(arg, DISPATCH_REPO_ALLOWLIST);
  if (!resolved.ok) {
    await ctx.reply(`No repo matches "${arg.trim().replace(/[<>&]/g, "")}". Valid: ${resolved.valid.map((r) => r.split("/")[1]).join(", ")}`);
    return;
  }
  let view: RepoStatusView;
  try {
    view = await deps.fetch(resolved.repos);
  } catch (err) {
    view = { summaries: [], unreachable: [{ repo: "all repositories", error: err instanceof Error ? err.message : String(err) }] };
  }
  for (const section of renderWhere(view.summaries, view.unreachable)) {
    for (const part of splitForTelegram(section)) {
      await ctx.reply(part, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    }
  }
  if (deps.capture) {
    try {
      const line = renderCaptureLine(await deps.capture(), new Date());
      if (line) await ctx.reply(line);
    } catch (err) {
      await ctx.reply(`Mac capture: status unavailable (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}
