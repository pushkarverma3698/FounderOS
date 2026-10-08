/**
 * The morning health line (AG-051): what is about to break, before a reply fails on it.
 * On 10-08 three of four blockers were outside services running out (the AI Studio 402, the OpenRouter key limit,
 * the Claude weekly limit), each found only when a reply failed. Pure: scripts/journey-daily.ts does the reads and
 * passes them in; a read that failed arrives as { error } and is printed red with its reason, never as green.
 */

/** Below this many dollars on the OpenRouter balance OR on the key's own limit, the line is red. */
export const OPENROUTER_MIN_USD = 1;

type Failed = { error: string };
const failed = (v: object): v is Failed => "error" in v;

export type ClaudePing = { exitCode: number; stdout: string; stderr: string } | Failed;

export interface GoogleRead {
  account: string;
  /** The mailbox gws reads for this account (getProfile emailAddress). */
  email?: string;
  error?: string;
  /** false when the account has no credentials.json and gws falls back to the host's default login. */
  ownLogin: boolean;
}

export interface HealthReads {
  /** /api/v1/credits (total_credits - total_usage) and /api/v1/key (limit_remaining; null = no key limit). */
  openRouter: { balanceUsd: number; keyRemainingUsd: number | null } | Failed;
  /** One generateContent call with maxOutputTokens 1. */
  aiStudio: { status: number; body: string } | Failed;
  claude: ClaudePing;
  google: readonly GoogleRead[];
  /** `systemctl --failed` unit names and `systemctl is-active founderos`. */
  units: { failed: readonly string[]; gateway: string } | Failed;
  /** ~/.claude/*.off files present: a daemon switched off on purpose. Shown, not red. */
  killSwitches: readonly string[];
  /** Yesterday's (IST) ai_call_costs total next to BUDGET_DAILY_USD. */
  spend: { yesterdayUsd: number; capUsd: number } | Failed;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;
const firstLine = (s: string, max = 160): string => (s.trim().split("\n")[0] ?? "").slice(0, max);

/** `claude -p ok --max-turns 1 --output-format json`. The weekly limit exits 0: only is_error and the text say so. */
export function parseClaudePing(p: ClaudePing): { ok: boolean; detail: string } {
  if (failed(p)) return { ok: false, detail: p.error };
  let result: { is_error?: unknown; subtype?: unknown; result?: unknown } | undefined;
  try {
    const parsed: unknown = JSON.parse(p.stdout.trim());
    if (parsed && typeof parsed === "object") result = parsed as typeof result;
  } catch {
    result = undefined;
  }
  if (p.exitCode !== 0) {
    const why = firstLine(p.stderr) || (typeof result?.result === "string" ? firstLine(result.result) : "") || "no output";
    return { ok: false, detail: `exit ${p.exitCode}: ${why}` };
  }
  if (!result) return { ok: false, detail: `exit 0 but the output is not the JSON result: ${firstLine(p.stdout, 80) || "empty"}` };
  const text = typeof result.result === "string" ? firstLine(result.result) : "";
  if (result.is_error === true || (typeof result.subtype === "string" && result.subtype.startsWith("error"))) {
    return { ok: false, detail: text || "the CLI reported an error with no text" };
  }
  return { ok: true, detail: "answered" };
}

function aiStudioLine(r: HealthReads["aiStudio"]): [boolean, string] {
  if (failed(r)) return [false, `AI Studio key: ${r.error}`];
  if (r.status === 200) return [true, "AI Studio key: answered"];
  let why = "";
  try {
    const body = JSON.parse(r.body) as { error?: { message?: string } };
    why = body.error?.message ?? "";
  } catch {
    why = r.body;
  }
  return [false, `AI Studio key: HTTP ${r.status}${why ? ` ${firstLine(why, 120)}` : ""}`];
}

function openRouterLine(r: HealthReads["openRouter"]): [boolean, string] {
  if (failed(r)) return [false, `OpenRouter: ${r.error}`];
  const key = r.keyRemainingUsd === null ? "no key limit" : `key limit ${usd(r.keyRemainingUsd)} left`;
  const left = Math.min(r.balanceUsd, r.keyRemainingUsd ?? Number.POSITIVE_INFINITY);
  const ok = left >= OPENROUTER_MIN_USD;
  return [ok, `OpenRouter: balance ${usd(r.balanceUsd)}, ${key}${ok ? "" : ` (below ${usd(OPENROUTER_MIN_USD)})`}`];
}

function googleLines(reads: readonly GoogleRead[]): Array<[boolean, string]> {
  const out: Array<[boolean, string]> = reads.map((g) =>
    g.error || !g.email
      ? [false, `Google ${g.account}: ${g.error ?? "no mailbox address returned"}`]
      : [true, `Google ${g.account} → ${g.email}${g.ownLogin ? "" : " (host default login)"}`],
  );
  // Two accounts with their own login reading one mailbox is the 10-08 mix-up (#1031): "work" answered with personal mail.
  const own = reads.filter((g) => g.ownLogin && g.email);
  for (let i = 0; i < own.length; i++) {
    for (let j = i + 1; j < own.length; j++) {
      if (own[i]!.email!.toLowerCase() === own[j]!.email!.toLowerCase()) {
        out.push([false, `Google: ${own[i]!.account} and ${own[j]!.account} both read ${own[i]!.email}`]);
      }
    }
  }
  return out;
}

function unitLines(r: HealthReads["units"]): Array<[boolean, string]> {
  if (failed(r)) return [[false, `systemd: ${r.error}`]];
  return [
    [r.gateway === "active", `Gateway (founderos.service): ${r.gateway}`],
    r.failed.length === 0 ? [true, "No failed units"] : [false, `${r.failed.length} failed units: ${r.failed.join(", ")}`],
  ];
}

function spendLine(r: HealthReads["spend"]): [boolean, string] {
  if (failed(r)) return [false, `Spend: ${r.error}`];
  const ok = r.yesterdayUsd <= r.capUsd;
  return [ok, `Spend yesterday: ${usd(r.yesterdayUsd)} of ${usd(r.capUsd)} daily cap`];
}

/** One line per check, 🟢 or 🔴, then any kill switch as 🟡. ok is false when any line is red. */
export function healthLine(r: HealthReads): { ok: boolean; lines: string[] } {
  const claude = parseClaudePing(r.claude);
  const checks: Array<[boolean, string]> = [
    openRouterLine(r.openRouter),
    aiStudioLine(r.aiStudio),
    [claude.ok, `Claude CLI (claude-agent): ${claude.detail}`],
    ...googleLines(r.google),
    ...unitLines(r.units),
    spendLine(r.spend),
  ];
  const lines = checks.map(([ok, text]) => `${ok ? "🟢" : "🔴"} ${text}`);
  if (r.killSwitches.length > 0) lines.push(`🟡 Switched off on purpose: ${r.killSwitches.join(", ")}`);
  return { ok: checks.every(([ok]) => ok), lines };
}
