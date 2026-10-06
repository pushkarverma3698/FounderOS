/**
 * Secret scrubber for Mac -> VPS brain capture (AG-027, audit F5).
 * Pure. A record that matches any pattern is DROPPED whole by the caller; this module
 * only names which pattern matched and never returns the matched text.
 */

interface SecretPattern {
  readonly name: string;
  readonly pattern: RegExp;
}

/** Ordered list of secret shapes. Names are what reach the run summary. */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "api-key-prefix", pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: "github-token", pattern: /\bghp_[A-Za-z0-9]{20,}/ },
  { name: "github-pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "pem-block", pattern: /-----BEGIN [A-Z0-9 ]+-----/ },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/ },
  { name: "url-credentials", pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/ },
  // NAME=value where NAME contains KEY, TOKEN, SECRET or PASSWORD; an empty value is not a secret.
  { name: "secret-env-line", pattern: /^[ \t]*(?:export[ \t]+)?[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*[ \t]*=[ \t]*[^\s=]/im },
];

/** Names of every pattern that matches `text`. Empty = clean. */
export function findSecrets(text: string): readonly string[] {
  return SECRET_PATTERNS.filter((p) => p.pattern.test(text)).map((p) => p.name);
}

export function containsSecret(text: string): boolean {
  return findSecrets(text).length > 0;
}
