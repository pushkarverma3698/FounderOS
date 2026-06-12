/**
 * REGRESSION — Bug #7: path-guard must block secret/system paths EVEN ON READ.
 * ============================================================================
 * History: `read_file` / `send_file` could exfiltrate secrets. A spoken or typed
 * "show me ~/.ssh/id_rsa" or "read my .env" must be DENIED, not just for writes
 * but for reads too — these files are exfiltration targets (CLAUDE.md security,
 * MEMORY 2026-06-11 leaked OPENAI/OPENROUTER keys via read_file ~/.zshrc).
 *
 * APPEND-ONLY. Never delete or weaken to make CI green. If a case here goes red,
 * the path-guard regressed — fix the guard, not the test.
 *
 * Teeth (Phase 8): loosening `resolveSafePath` (e.g. dropping the secret/system
 * denylist) turns these red. Verified red-then-green in TESTING_PIPELINE_REPORT.
 */

import { describe, it, expect } from "vitest";
import { resolveSafePath } from "../../src/infra/path-guard.js";

const SECRET_TARGETS = [
  "~/.ssh/id_rsa",
  "~/.ssh/id_rsa.pub",
  "~/.env",
  "~/project/.env.production",
  "~/cert.pem",
  "~/service.key",
  "~/.aws/credentials",
  "~/.zshrc",
  "~/.bash_profile",
];

const SYSTEM_TARGETS = ["/etc/passwd", "/etc/shadow", "/private/etc/hosts", "/usr/bin/env", "/var/log/auth.log"];

describe("REGRESSION bug#7 — secret paths are denied even for reads", () => {
  for (const target of SECRET_TARGETS) {
    it(`denies secret path: ${target}`, () => {
      const result = resolveSafePath(target);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason.toLowerCase()).toMatch(/secret|sensitive|denied/);
    });
  }
});

describe("REGRESSION bug#7 — system paths are denied even for reads", () => {
  for (const target of SYSTEM_TARGETS) {
    it(`denies system path: ${target}`, () => {
      const result = resolveSafePath(target);
      expect(result.ok).toBe(false);
    });
  }
});

describe("REGRESSION bug#7 — path traversal out of home is denied", () => {
  it("rejects ../ traversal that climbs out of the personal root", () => {
    const result = resolveSafePath("~/../../etc/passwd");
    expect(result.ok).toBe(false);
  });
});
