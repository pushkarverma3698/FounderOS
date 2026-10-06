import { describe, it, expect } from "vitest";
import { findSecrets, containsSecret } from "../../../src/lib/secret-scrub.js";

// Real-shaped fakes, assembled at runtime so no scanner mistakes this file for a leak.
const A = (n: number) => "a1B2c3D4e5".repeat(Math.ceil(n / 10)).slice(0, n);

describe("secret scrubber", () => {
  const positives: ReadonlyArray<readonly [string, string]> = [
    ["api-key-prefix", `key is sk-${A(32)} ok`],
    ["github-token", `ghp_${A(36)}`],
    ["github-pat", `github_pat_${A(40)}`],
    ["slack-token", `xoxb-${"1234567890-".repeat(2)}${A(12)}`],
    ["aws-access-key", `AKIA${"ABCDEFGH12345678".slice(0, 16)}`],
    ["pem-block", "-----BEGIN RSA PRIVATE KEY-----\nMIIfake\n-----END RSA PRIVATE KEY-----"],
    ["jwt", `eyJ${A(12)}.eyJ${A(12)}.${A(20)}`],
    ["url-credentials", "postgres://admin:hunter2pass@db.example.com:5432/app"],
    ["bearer-token", `Authorization: Bearer ${A(30)}`],
    ["secret-env-line", "export STRIPE_SECRET_KEY=abc123xyz"],
    ["secret-env-line", "DB_PASSWORD=correct-horse"],
    ["secret-env-line", "  GITHUB_TOKEN = abcdef"],
  ];

  it.each(positives)("flags %s", (name, text) => {
    expect(findSecrets(text)).toContain(name);
    expect(containsSecret(text)).toBe(true);
  });

  it("passes ordinary engineering prose and URLs without credentials", () => {
    const clean = [
      "Fixed the retry loop in src/kernel/worker.ts and opened PR #957.",
      "See https://github.com/pushkarverma3698/FounderOS/pull/382 for details.",
      "Set API_KEY= in your shell before running (no value given).",
      "The sk- prefix and the word Bearer alone are not secrets.",
      "postgres://localhost:5432/app has no credentials",
      "tokenizer length is 42; PASSWORD policy discussed",
    ].join("\n");
    expect(findSecrets(clean)).toEqual([]);
    expect(containsSecret(clean)).toBe(false);
  });

  it("never returns the matched secret text, only pattern names", () => {
    const found = findSecrets(`ghp_${A(36)}`);
    expect(JSON.stringify(found)).not.toContain("a1B2");
  });
});
