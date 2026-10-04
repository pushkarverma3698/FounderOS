/**
 * Whose queue a job command means, decided by who sent it (telegram UX audit P1-4).
 *
 * `JOBHUNT_SENDER_PROFILES="<telegram user id>=<profile token>,…"` maps a sender to
 * their candidate profile, so Tashi's plain `/today` reads her queue without the
 * `/wife_*` prefix. An explicit profile in the message always wins, and unmapped
 * senders are untouched. The `/wife_*` commands keep working as hidden aliases.
 * Ids live in env, never in the repo.
 */
import { resolveProfileToken } from "../tools/jobhunt/profile-config.js";

export const JOB_COMMANDS: ReadonlySet<string> = new Set([
  "draft", "ask", "applied", "replied", "rejected", "profile", "jobs", "today", "fresh", "csv", "gaps",
]);

export function parseSenderProfiles(raw: string | undefined): ReadonlyMap<number, string> {
  const map = new Map<number, string>();
  for (const pair of (raw ?? "").split(",")) {
    const [id, token] = pair.split("=").map((s) => s.trim());
    const n = Number(id);
    if (Number.isSafeInteger(n) && n > 0 && token) map.set(n, token);
  }
  return map;
}

/** `/today` → `/today tashi`; leaves non-job commands and explicit profiles alone. */
export function injectSenderProfile(text: string, token: string): string {
  const m = /^\/([A-Za-z_]+)(@\w+)?(?:\s+([\s\S]*))?$/.exec(text);
  if (!m || !JOB_COMMANDS.has(m[1]!.toLowerCase())) return text;
  const rest = (m[3] ?? "").trim();
  const first = rest.split(/\s+/)[0] ?? "";
  if (first && resolveProfileToken(first)) return text;
  return `/${m[1]}${m[2] ?? ""} ${token}${rest ? ` ${rest}` : ""}`;
}
