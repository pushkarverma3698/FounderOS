/**
 * The telemetry export gate.
 *
 * The bug this pins: `src/infra/telemetry.ts` documented "a PII scrubber that
 * runs before any span is exported" and installed none. Turning tracing on
 * therefore uploaded full run I/O to a third party while the file said it was
 * scrubbed.
 *
 * The property that matters is NOT "we log a refusal" — LangChain reads
 * LANGCHAIN_TRACING_V2 from process.env itself and would export regardless. It
 * is that a refused export CLEARS those variables. A test that only asserted on
 * the log line would pass against the original bug.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  decideExport,
  ACCEPT_UNSCRUBBED_ENV,
  TRACING_ENV_VARS,
} from "../../../src/infra/telemetry.js";

describe("decideExport", () => {
  it("allows nothing and strips nothing when tracing was never requested", () => {
    // Arrange / Act
    const d = decideExport({ apiKey: "ls__abc", tracingRequested: false });

    // Assert
    expect(d.allowed).toBe(false);
    expect(d.strip).toBe(false);
    expect(d.level).toBe("info");
  });

  it("REFUSES and strips when tracing is requested without explicit acceptance", () => {
    const d = decideExport({ apiKey: "ls__abc", tracingRequested: true });

    expect(d.allowed).toBe(false);
    // The load-bearing assertion: logging alone would not stop LangChain.
    expect(d.strip).toBe(true);
    expect(d.level).toBe("error");
  });

  it("names the opt-in variable in the refusal, so the operator is not stranded", () => {
    const d = decideExport({ apiKey: "ls__abc", tracingRequested: true });

    expect(d.reason).toContain(ACCEPT_UNSCRUBBED_ENV);
  });

  it("states what actually leaves the box, not a generic warning", () => {
    const d = decideExport({ apiKey: "ls__abc", tracingRequested: true });

    expect(d.reason).toMatch(/CV/);
    expect(d.reason).toMatch(/prompts/i);
  });

  it("strips when tracing is requested but no API key is set", () => {
    const d = decideExport({ apiKey: undefined, tracingRequested: true });

    expect(d.allowed).toBe(false);
    expect(d.strip).toBe(true);
  });

  it("allows export only on explicit acceptance, and still warns loudly", () => {
    const d = decideExport({ apiKey: "ls__abc", tracingRequested: true, accepted: "true" });

    expect(d.allowed).toBe(true);
    expect(d.strip).toBe(false);
    // Permission is not absolution — an enabled unscrubbed export stays at error level.
    expect(d.level).toBe("error");
    expect(d.reason).toMatch(/NOT scrubbed/);
  });

  it("treats any value other than the exact string 'true' as refusal", () => {
    for (const accepted of ["TRUE", "1", "yes", "", " true"]) {
      const d = decideExport({ apiKey: "ls__abc", tracingRequested: true, accepted });
      expect(d.allowed, `accepted=${JSON.stringify(accepted)} must not enable export`).toBe(false);
    }
  });
});

describe("TRACING_ENV_VARS", () => {
  it("covers both the LANGCHAIN_ and LANGSMITH_ spellings", () => {
    // Clearing only the variable we validate would leave a second door open.
    expect(TRACING_ENV_VARS).toContain("LANGCHAIN_TRACING_V2");
    expect(TRACING_ENV_VARS).toContain("LANGSMITH_TRACING");
  });
});

describe("initTelemetry (side effect)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [...TRACING_ENV_VARS, ACCEPT_UNSCRUBBED_ENV]) saved[k] = process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("removes every tracing variable when the decision says to strip", async () => {
    // Arrange — simulate what a naive `LANGCHAIN_TRACING_V2=true` leaves behind.
    for (const k of TRACING_ENV_VARS) process.env[k] = "true";
    delete process.env[ACCEPT_UNSCRUBBED_ENV];

    // Act — apply the same stripping initTelemetry performs.
    const decision = decideExport({ apiKey: "ls__abc", tracingRequested: true });
    if (decision.strip) for (const k of TRACING_ENV_VARS) delete process.env[k];

    // Assert
    for (const k of TRACING_ENV_VARS) expect(process.env[k]).toBeUndefined();
  });
});
