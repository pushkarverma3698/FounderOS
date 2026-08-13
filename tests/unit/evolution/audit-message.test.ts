/**
 * Task 3 — the founder-facing message must ARRIVE and must not overclaim.
 * ========================================================================
 * The escaping tests are not hypothetical. `normalizeFailureSignature`
 * (src/kernel/lessons.ts) rewrites volatile tokens as `<n>`, `<uuid>`, `<hash>`,
 * `<url>`, `<email>` and `<payload>`, and those signatures become finding
 * subjects and evidence verbatim. Sent with `parse_mode: "HTML"` unescaped, a
 * single telemetry finding made Telegram reject the whole message, and the
 * sweep's catch turned that into silence.
 */

import { describe, expect, it } from "vitest";
import { renderAuditMessage, renderAuditCrashMessage, MAX_REGRESSED_SHOWN } from "../../../src/evolution/audit-message.js";
import type { AuditRunResult, PersistenceOutcome } from "../../../src/evolution/run-audit.js";
import type { Finding } from "../../../src/evolution/types.js";

/** Telegram Bot API's complete HTML tag whitelist. Anything else is a 400. */
const TELEGRAM_ALLOWED_TAGS = new Set([
  "b", "strong", "i", "em", "u", "ins", "s", "strike", "del",
  "span", "tg-spoiler", "a", "code", "pre", "blockquote",
]);

/** Every tag-like token in the message that Telegram would refuse to parse. */
function unsupportedTags(message: string): string[] {
  const tags = [...message.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g)].map((m) => m[1]!.toLowerCase());
  return [...new Set(tags.filter((t) => !TELEGRAM_ALLOWED_TAGS.has(t)))];
}

const DISABLED: PersistenceOutcome = { state: "disabled" };

function run(overrides: Partial<AuditRunResult> = {}): AuditRunResult {
  return {
    staticResults: [],
    telemetryResults: [],
    telemetrySkippedReason: null,
    ranked: [],
    ...overrides,
  };
}

/** A finding carrying a real normalized failure signature. */
const SIGNATURE_FINDING: Finding = {
  kind: "unapplied-lesson",
  subject: "outbound:tool gmail_send failed after <n> attempts (status <n>) for user <uuid>",
  evidence:
    "Lesson for outbound:tool gmail_send failed after <n> attempts for user <uuid> has a known fix " +
    "(resolved 2× by a retry) & the failure has been seen 7 times, but the lesson has never been injected.",
  severity: "high",
};

describe("renderAuditMessage — the message survives Telegram's HTML parser", () => {
  it("escapes the angle brackets a normalized failure signature puts in a finding", () => {
    const message = renderAuditMessage(run({ ranked: [SIGNATURE_FINDING] }), DISABLED);

    expect(unsupportedTags(message)).toEqual([]);
    expect(message).toContain("&lt;n&gt;");
    expect(message).toContain("&lt;uuid&gt;");
    expect(message).not.toContain("<n>");
    expect(message).not.toContain("<uuid>");
  });

  it("escapes ampersands so the entity parser cannot choke either", () => {
    const message = renderAuditMessage(run({ ranked: [SIGNATURE_FINDING] }), DISABLED);
    expect(message).toContain("&amp;");
  });

  it("escapes a skip reason containing markup", () => {
    const message = renderAuditMessage(
      run({ telemetrySkippedReason: 'relation "a<b>" & c does not exist' }),
      DISABLED,
    );

    expect(unsupportedTags(message)).toEqual([]);
    expect(message).toContain("&lt;b&gt;");
    expect(message).toContain("&amp;");
  });

  it("still emits the findings themselves, not just a safe empty shell", () => {
    const message = renderAuditMessage(run({ ranked: [SIGNATURE_FINDING] }), DISABLED);
    expect(message).toContain("gmail_send");
    expect(message).toContain("seen 7 times");
  });
});

describe("renderAuditMessage — a tier that did not run never reads as clean", () => {
  it("banners a skipped telemetry tier and names the analyzers that went dark", () => {
    const message = renderAuditMessage(
      run({ telemetrySkippedReason: "connect ECONNREFUSED 127.0.0.1:5432" }),
      DISABLED,
    );

    expect(message).toContain("TELEMETRY DID NOT RUN");
    expect(message).toContain("not a clean result");
    expect(message).toContain("ECONNREFUSED");
    expect(message).toContain("findCostHotspots");
    expect(message).toContain("findRecurringFailures");
    expect(message).toContain("findUnappliedLessons");
  });

  it("emits no banner when telemetry actually ran", () => {
    const message = renderAuditMessage(run(), DISABLED);
    expect(message).not.toContain("DID NOT RUN");
  });
});

describe("renderAuditMessage — the recurrence delta is honest about what it knows", () => {
  it("says tracking is off rather than printing zeros", () => {
    const message = renderAuditMessage(run(), DISABLED);

    expect(message).toContain("EVOLUTION_PERSIST_FINDINGS=false");
    expect(message).not.toContain("0 new");
  });

  it("says UNKNOWN when the store write failed, never a zero delta", () => {
    const message = renderAuditMessage(run(), {
      state: "attempted",
      result: {
        persisted: false, runId: null, newCount: 0, recurringCount: 0,
        regressedCount: 0, resolvedCount: 0, regressed: [], error: "connection terminated",
      },
    });

    expect(message).toContain("failed to write");
    expect(message).toContain("UNKNOWN");
    expect(message).toContain("connection terminated");
    expect(message).not.toContain("0 new");
  });

  it("prints the delta when the run persisted", () => {
    const message = renderAuditMessage(run(), {
      state: "attempted",
      result: {
        persisted: true, runId: "r1", newCount: 3, recurringCount: 12,
        regressedCount: 1, resolvedCount: 2, regressed: [],
      },
    });

    expect(message).toContain("3 new");
    expect(message).toContain("12 recurring");
    expect(message).toContain("1 regressed");
    expect(message).toContain("2 resolved");
  });

  it("calls out regressed findings by name and escapes them", () => {
    const message = renderAuditMessage(run(), {
      state: "attempted",
      result: {
        persisted: true, runId: "r1", newCount: 0, recurringCount: 0,
        regressedCount: 1, resolvedCount: 0,
        regressed: [{ fingerprint: "fp1", kind: "dead-export", subject: "Record<string>", location: "src/a.ts", timesSeen: 4 }],
      },
    });

    expect(message).toContain("REGRESSED");
    expect(message).toContain("marked fixed, now back");
    expect(message).toContain("Record&lt;string&gt;");
    expect(message).toContain("src/a.ts");
    expect(message).toContain("seen 4×");
    expect(unsupportedTags(message)).toEqual([]);
  });

  it("caps the regressed list but never hides the count", () => {
    const regressed = Array.from({ length: MAX_REGRESSED_SHOWN + 3 }, (_, i) => ({
      fingerprint: `fp${i}`, kind: "dead-export", subject: `sym${i}`, timesSeen: 2,
    }));

    const message = renderAuditMessage(run(), {
      state: "attempted",
      result: {
        persisted: true, runId: "r1", newCount: 0, recurringCount: 0,
        regressedCount: regressed.length, resolvedCount: 0, regressed,
      },
    });

    expect(message).toContain("sym0");
    expect(message).not.toContain("sym7");
    expect(message).toContain(`+ 3 more regressed (${regressed.length} total).`);
  });
});

describe("renderAuditCrashMessage — a crashed audit is reported, not swallowed", () => {
  it("states that no findings were produced and why", () => {
    const message = renderAuditCrashMessage("Cannot locate repository root above /opt/founderos/dist");

    expect(message).toContain("SELF-AUDIT FAILED TO RUN");
    expect(message).toContain("not a clean result");
    expect(message).toContain("Cannot locate repository root");
    expect(message).not.toMatch(/no findings\./i);
  });

  it("escapes the reason", () => {
    const message = renderAuditCrashMessage('ENOENT: no such file "<root>/package.json" & friends');
    expect(unsupportedTags(message)).toEqual([]);
    expect(message).toContain("&lt;root&gt;");
  });
});
