/**
 * FounderOS — Personal Department Path Guard
 * ==========================================
 * Deterministic safety limit for the `personal` department's filesystem + shell
 * tools. The agent ingests untrusted email/web text (prompt-injection in scope),
 * so this is a HARD gate that does NOT depend on the LLM behaving:
 *
 *   - every file path and shell cwd must resolve INSIDE the personal root
 *     (PERSONAL_ROOT env, default $HOME)
 *   - secret + system paths are denied EVEN FOR READS (they are exfil targets)
 *
 * Pure functions — no I/O, fully unit-tested.
 */

import os from "node:os";
import path from "node:path";

export type SafePath = { ok: true; path: string } | { ok: false; reason: string };

/** Default root the personal department may touch. */
export function personalRoot(): string {
  const root = process.env["PERSONAL_ROOT"];
  return root && root.trim() ? path.resolve(expandHome(root.trim())) : os.homedir();
}

/** Expand a leading ~ to the home directory. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Secret/system path patterns denied even for reads. Matched against the
 * resolved absolute path's segments / suffix, case-insensitive.
 */
const SECRET_SEGMENTS = [
  ".ssh",
  ".aws",
  ".gnupg",
  path.join(".config", "gh"),
  path.join("Library", "Keychains"),
];
const SECRET_SUFFIX = [".pem", ".env"];
const SECRET_BASENAME = /^id_rsa(\.pub)?$|(^|.*\/)\.env(\..+)?$/i;
const SYSTEM_ROOTS = ["/etc", "/System", "/Library", "/private", "/usr", "/bin", "/sbin", "/var"];

function isSecret(abs: string): boolean {
  const lower = abs.toLowerCase();
  if (SECRET_SEGMENTS.some((seg) => lower.includes(`/${seg.toLowerCase()}/`) || lower.endsWith(`/${seg.toLowerCase()}`))) {
    return true;
  }
  if (SECRET_SUFFIX.some((s) => lower.endsWith(s))) return true;
  if (SECRET_BASENAME.test(path.basename(abs))) return true;
  return false;
}

/**
 * Resolve `input` to an absolute path and confirm it is safe:
 * inside `root` (default personalRoot()) and not on the secret/system denylist.
 */
export function resolveSafePath(input: string, root?: string): SafePath {
  const base = root ? path.resolve(expandHome(root)) : personalRoot();
  const expanded = expandHome(input.trim());
  const abs = path.resolve(base, expanded);

  // System roots are never allowed (covers absolute /etc, /usr, etc).
  if (SYSTEM_ROOTS.some((r) => abs === r || abs.startsWith(`${r}/`))) {
    return { ok: false, reason: `Denied: '${abs}' is a protected system path.` };
  }

  // Must stay within the personal root.
  if (abs !== base && !abs.startsWith(`${base}${path.sep}`)) {
    return { ok: false, reason: `Denied: '${abs}' is outside the personal root '${base}'.` };
  }

  if (isSecret(abs)) {
    return { ok: false, reason: `Denied: '${abs}' is a secret/sensitive path (blocked even for reads).` };
  }

  return { ok: true, path: abs };
}

/**
 * Heuristic flag for catastrophic shell commands. NOT a blocker — the founder's
 * HITL approval is the real control — but it surfaces the danger in the card.
 */
export function flagDangerousCommand(cmd: string): boolean {
  const c = cmd.toLowerCase();
  const patterns: RegExp[] = [
    /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/, // rm -rf / -fr (any flag order)
    /\bmkfs\b/,
    /\bdd\b.*\bof=\/dev\//,
    /:\(\)\s*\{.*\}\s*;\s*:/, // fork bomb :(){ :|:& };:
    /\b(shutdown|reboot|halt)\b/,
    />\s*\/dev\/(sd|disk|hd)/,
  ];
  return patterns.some((p) => p.test(c));
}
