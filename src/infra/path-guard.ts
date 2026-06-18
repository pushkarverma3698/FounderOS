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
const SECRET_SUFFIX = [".pem", ".env", ".key"];
const SECRET_BASENAME = /^id_rsa(\.pub)?$|(^|.*\/)\.env(\..+)?$/i;
const SYSTEM_ROOTS = ["/etc", "/System", "/Library", "/private", "/usr", "/bin", "/sbin", "/var"];

/**
 * Exact basenames denied even for reads — config/credential files that routinely
 * hold plaintext secrets via `export KEY=...` or `password=...`. Added 2026-06-11
 * after an E2E run proved `read_file ~/.zshrc` exfiltrated live OPENAI / OPENROUTER
 * keys into Telegram. Matched case-insensitively against the resolved basename.
 */
const SECRET_BASENAMES = new Set(
  [
    // credential / token stores (shell rc files are allowed — readFileSafe redacts secrets)
    ".netrc", ".npmrc", ".pypirc", ".git-credentials", ".dockercfg",
    "credentials", "secrets.json", "secrets.yaml", "secrets.yml",
  ].map((s) => s.toLowerCase()),
);

function isSecret(abs: string): boolean {
  const lower = abs.toLowerCase();
  if (SECRET_SEGMENTS.some((seg) => lower.includes(`/${seg.toLowerCase()}/`) || lower.endsWith(`/${seg.toLowerCase()}`))) {
    return true;
  }
  if (SECRET_SUFFIX.some((s) => lower.endsWith(s))) return true;
  if (SECRET_BASENAME.test(path.basename(abs))) return true;
  if (SECRET_BASENAMES.has(path.basename(abs).toLowerCase())) return true;
  return false;
}

/**
 * High-confidence live-credential token patterns. Near-zero false positives: these
 * are vendor-prefixed key shapes that should NEVER transit Telegram regardless of
 * which file they live in. Defense-in-depth for the path-guard denylist — catches
 * a secret pasted into an arbitrary (non-denylisted) file. Pure + unit-tested.
 */
const SECRET_TOKEN_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{20,}/g,              // OpenAI / OpenRouter (sk-, sk-proj-, sk-or-v1-)
  /ghp_[A-Za-z0-9]{30,}/g,              // GitHub PAT (classic)
  /gho_[A-Za-z0-9]{30,}/g,              // GitHub OAuth token
  /github_pat_[A-Za-z0-9_]{40,}/g,      // GitHub PAT (fine-grained)
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,      // Slack tokens
  /AKIA[0-9A-Z]{16}/g,                  // AWS access key id
  /AIza[0-9A-Za-z_-]{35}/g,             // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, // PEM private-key block
];

const SECRET_REDACTION = "«REDACTED-SECRET»";

/**
 * Replace any high-confidence live-credential tokens in `content` with a redaction
 * marker. Returns the scrubbed text and how many secrets were redacted, so callers
 * can warn the founder without ever transmitting the secret bytes.
 */
export function redactSecrets(content: string): { redacted: string; count: number } {
  let count = 0;
  let out = content;
  for (const re of SECRET_TOKEN_PATTERNS) {
    out = out.replace(re, () => {
      count++;
      return SECRET_REDACTION;
    });
  }
  return { redacted: out, count };
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
