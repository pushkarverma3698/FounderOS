/**
 * Antigravity failure classifier — deploy/lib/agy-failure.sh.
 * ===========================================================
 * Before this, agent-dispatch knew ONE failure: a quota wall. Every other run that
 * ended without a PR became agent:failed — terminal — so a login that had expired,
 * or one `Error: timeout waiting for response` (seen 3 times), killed the issue for
 * good and nobody could tell "broken" from "idle" from "paused".
 *
 * The classifier is a pure function of the log, so it is tested as one. The property
 * that matters is the ASYMMETRY of the two mistakes:
 *   - a false "auth" pauses the WHOLE loop until the founder acts;
 *   - a false "unknown" only degrades to the old behaviour (agent:failed + a message).
 * So it classifies only the TAIL of the log (where the terminating error lives), only
 * on lines the CLI itself printed about a failure (never prose or echoed code), and a
 * bare number counts only in an HTTP/status context.
 *
 * Provenance is in every test title. "verbatim" means the plan, an existing test or a
 * source comment quotes that exact line; everything else is "synthetic": written here to
 * exercise a pattern, NOT captured from a real Antigravity run. One real auth failure has
 * been observed (an agy with no login, 2026-10-02); the auth and transient formats other than that one and
 * the plan's are guesses until a production log confirms them.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = fileURLToPath(new URL("../../../deploy/lib/agy-failure.sh", import.meta.url));

type Klass = "quota" | "auth" | "transient";
type Provenance = "verbatim" | "synthetic";

/** One line per pattern, in the order `agy_patterns <class>` prints them (1-based). */
interface Fixture {
  readonly klass: Klass;
  readonly pattern: number;
  readonly line: string;
  readonly provenance: Provenance;
}

const FIXTURES: readonly Fixture[] = [
  // quota — the sample is the line agent-dispatch-quota.test.ts and the plan quote
  { klass: "quota", pattern: 1, provenance: "verbatim", line: "error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 57h37m44s." },
  { klass: "quota", pattern: 2, provenance: "synthetic", line: "Error: 429 RESOURCE_EXHAUSTED: quota exceeded for this project" },
  // auth
  { klass: "auth", pattern: 1, provenance: "synthetic", line: "Error: 403 PERMISSION_DENIED: The caller does not have permission" },
  { klass: "auth", pattern: 2, provenance: "synthetic", line: "error: UNAUTHENTICATED: Request had invalid authentication credentials" },
  { klass: "auth", pattern: 3, provenance: "synthetic", line: "Error: invalid_grant: Token has been expired or revoked." },
  { klass: "auth", pattern: 4, provenance: "synthetic", line: "Error: API key not valid. Please pass a valid API key." },
  { klass: "auth", pattern: 5, provenance: "synthetic", line: '{"error":{"code":400,"message":"nope","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}' },
  { klass: "auth", pattern: 6, provenance: "synthetic", line: "error: Please log in to continue." },
  { klass: "auth", pattern: 7, provenance: "synthetic", line: "Error: not logged in (run agy interactively)" },
  { klass: "auth", pattern: 8, provenance: "verbatim", line: "HTTP 401: Bad credentials" },
  { klass: "auth", pattern: 9, provenance: "synthetic", line: "gh: request failed with status: 403" },
  // captured 2026-10-02 from agy 1.2.14 run with an empty HOME (no login): stderr, exit 1
  { klass: "auth", pattern: 10, provenance: "verbatim", line: "error: authentication failed or timed out" },
  // transient
  { klass: "transient", pattern: 1, provenance: "verbatim", line: "Error: timeout waiting for response" },
  { klass: "transient", pattern: 2, provenance: "verbatim", line: "timeout: failed to execute process" },
  { klass: "transient", pattern: 3, provenance: "synthetic", line: "Error: read ECONNRESET" },
  { klass: "transient", pattern: 4, provenance: "synthetic", line: "error: rpc error: code = Unavailable desc = the service is currently unavailable" },
  { klass: "transient", pattern: 5, provenance: "synthetic", line: "Error: request failed with status code 503" },
];

let root: string;
let logFile: string;

function bash(script: string, args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bash", ["-c", script, "_", ...args], {
    env: { PATH: "/usr/bin:/bin:/usr/local/bin", HOME: root },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** classify_agy_failure over a log with exactly this content. */
function classify(logText: string): string {
  writeFileSync(logFile, logText);
  return bash(`source "${LIB}"; classify_agy_failure "$1"`, [logFile]).stdout.trim();
}

/** Narration an agent prints while it works: it must never influence the verdict. */
const noise = (n: number, prefix = "I am reading file"): string =>
  Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join("\n");

const patternsOf = (klass: Klass): string[] =>
  bash(`source "${LIB}"; agy_patterns ${klass}`).stdout.split("\n").filter((l) => l !== "");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agy-failure-"));
  mkdirSync(join(root, "x"), { recursive: true });
  logFile = join(root, "agy.log");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("classify_agy_failure — every pattern, against a real or labelled-synthetic line", () => {
  it.each(FIXTURES.map((f) => [`${f.klass} #${f.pattern} [${f.provenance}]`, f] as const))(
    "%s classifies as its class",
    (_title, f) => {
      expect(classify(`${noise(5)}\n${f.line}\n`)).toBe(f.klass);
    },
  );

  it.each(FIXTURES.map((f) => [`${f.klass} #${f.pattern} [${f.provenance}]`, f] as const))(
    "%s: the fixture really exercises THAT pattern, not another one",
    (_title, f) => {
      const pattern = patternsOf(f.klass)[f.pattern - 1];
      expect(pattern, `${f.klass} has no pattern #${f.pattern}`).toBeTruthy();
      const r = bash(`printf '%s\\n' "$1" | grep -Eaiq -- "$2"`, [f.line, pattern ?? ""]);
      expect(r.status, `pattern ${JSON.stringify(pattern)} does not match ${JSON.stringify(f.line)}`).toBe(0);
    },
  );

  it.each(["quota", "auth", "transient"] as const)(
    "%s: every pattern in the array has a fixture (a new pattern cannot ship untested)",
    (klass) => {
      const patterns = patternsOf(klass);
      const covered = FIXTURES.filter((f) => f.klass === klass).map((f) => f.pattern);
      expect(covered.sort((a, b) => a - b)).toEqual(patterns.map((_, i) => i + 1));
    },
  );
});

describe("classify_agy_failure — the whole block a real login failure prints [verbatim, 2026-10-02]", () => {
  // stderr of `agy --print` as a user with no login, then the text view agy-run.sh builds from the result
  // event: the same words a second time, prefixed "Error:". Captured from agy 1.2.14 on the VPS.
  const REAL = [
    "Authentication required. Please visit the URL to log in:",
    "  https://accounts.google.com/o/oauth2/auth?access_type=offline&prompt=consent",
    "",
    "Waiting for authentication (timeout 60s)...",
    "Or, paste the authorization code here and press Enter:",
    "Error: authentication timed out.",
    "error: authentication failed or timed out",
    "Error: authentication failed or timed out",
  ].join("\n");

  it("is auth, so the loop pauses and the issue goes back to agent:ready instead of agent:failed", () => {
    expect(classify(`${REAL}\n`)).toBe("auth");
  });

  it("is quoted as the CLI's own line, not the URL above it", () => {
    writeFileSync(logFile, `${REAL}\n`);
    const r = bash(`source "${LIB}"; agy_failure_line auth "$1"`, [logFile]);
    expect(r.stdout.trim()).toBe("Error: authentication timed out.");
  });
});

describe("classify_agy_failure — precedence", () => {
  const quota = FIXTURES[0]?.line ?? "";
  const auth = "Error: 403 PERMISSION_DENIED: The caller does not have permission"; // [synthetic]
  const transient = "Error: timeout waiting for response"; // [verbatim]

  it("quota wins over auth when both are in the tail, in either order [verbatim quota + synthetic auth]", () => {
    expect(classify(`${auth}\n${quota}\n`)).toBe("quota");
    expect(classify(`${quota}\n${auth}\n`)).toBe("quota");
  });

  it("quota wins over transient in either order", () => {
    expect(classify(`${transient}\n${quota}\n`)).toBe("quota");
    expect(classify(`${quota}\n${transient}\n`)).toBe("quota");
  });

  it("auth wins over transient: a rejected credential explains the rest, retrying would burn quota", () => {
    expect(classify(`${transient}\n${auth}\n`)).toBe("auth");
    expect(classify(`${auth}\n${transient}\n`)).toBe("auth");
  });

  it("a quota wall with no 'Resets in' is still quota (the daemon then backs off one hour)", () => {
    expect(classify("error: Individual quota reached. Please upgrade your subscription.\n")).toBe("quota");
  });
});

describe("classify_agy_failure — unknown", () => {
  it("an ordinary failure is unknown [verbatim: the existing quota test's own line]", () => {
    expect(classify("Error: something else broke\n")).toBe("unknown");
  });

  it("an empty log, a missing log and a log of blank lines are unknown, never a crash", () => {
    expect(classify("")).toBe("unknown");
    expect(classify("\n\n   \n")).toBe("unknown");
    const r = bash(`source "${LIB}"; classify_agy_failure "$1"`, [join(root, "does-not-exist.log")]);
    expect(r.stdout.trim()).toBe("unknown");
    expect(r.status).toBe(0);
  });

  it("binary junk is unknown", () => {
    writeFileSync(logFile, Buffer.from([0, 255, 254, 1, 2, 3, 10, 0, 65, 66]));
    expect(bash(`source "${LIB}"; classify_agy_failure "$1"`, [logFile]).stdout.trim()).toBe("unknown");
  });
});

describe("classify_agy_failure — false positives (all synthetic: an agent DISCUSSING these things)", () => {
  // Each of these is text an Antigravity transcript can legitimately contain while it
  // implements a task that is ABOUT login, HTTP status codes or this very daemon. The
  // run ended for some other reason; none of it may pause the loop or retry the issue.
  const PROSE: readonly (readonly [string, string])[] = [
    ["a bare 401 in narration", "I updated src/auth.ts so the API returns 401 when the token is missing."],
    ["'please log in' as UI copy in code it wrote", '  throw new Error("Please log in first");'],
    ["'please log in' in a sentence", "The login page now tells anonymous visitors to please log in to continue."],
    ["'500 lines' about a file", "The generated file is 500 lines long and passes lint."],
    ["HTTP 401 in prose", "Added a test that expects HTTP 401 for an anonymous caller."],
    ["a status code in a bullet", "- Error handling for status: 503 was added to the retry wrapper"],
    ["a retry list in code", "const RETRY_ON = [429, 500, 502, 503, 504];"],
    ["an assertion in a test it wrote", "    expect(res.status).toBe(401);"],
    ["a markdown heading", "## Error handling"],
    ["the quota phrase in documentation it wrote", "I documented that agent-dispatch backs off on 'Individual quota reached' errors."],
    ["RESOURCE_EXHAUSTED in code", '    if (code === "RESOURCE_EXHAUSTED") retry();'],
    ["PERMISSION_DENIED in a comment", "// PERMISSION_DENIED means the key lacks the scope; UNAUTHENTICATED means it is missing"],
    ["timeout wording in a summary", "I raised the timeout waiting for response from 30s to 60s in the client."],
    ["a stack trace fragment", "    at Object.<anonymous> (/opt/agy-workspace/founderos/src/auth.ts:401:12)"],
  ];

  it.each(PROSE)("does not classify %s [synthetic]", (_what, line) => {
    expect(classify(`${noise(3)}\n${line}\n${noise(3)}\n`)).toBe("unknown");
  });

  it("does not classify a whole transcript of that prose either [synthetic]", () => {
    const transcript = PROSE.map(([, line]) => line).join("\n");
    expect(classify(transcript + "\n")).toBe("unknown");
  });

  it("a line that only STARTS like an error is not enough: 'Error handling: …' is prose [synthetic]", () => {
    expect(classify("Error handling: when the API returns HTTP 401 we redirect to /login\n")).toBe("unknown");
  });

  it("a bare number inside a real error line is not a status: 'Error: 500 lines exceeded' [synthetic]", () => {
    expect(classify("Error: file has more than 500 lines\n")).toBe("unknown");
    expect(classify("Error: 401 entries could not be parsed\n")).toBe("unknown");
  });
});

describe("classify_agy_failure — only the tail counts", () => {
  it("an old auth error, 60 lines before the real terminating error, does not decide the verdict [synthetic auth + verbatim transient]", () => {
    const text = `error: UNAUTHENTICATED: stale\n${noise(60)}\nError: timeout waiting for response\n`;
    expect(classify(text)).toBe("transient");
  });

  it("an old quota line outside the tail is not a quota wall [verbatim quota]", () => {
    const quota = FIXTURES[0]?.line ?? "";
    expect(classify(`${quota}\n${noise(60)}\nError: something else broke\n`)).toBe("unknown");
  });

  it("the window is the constant the script exports, not a magic number", () => {
    const n = Number(bash(`source "${LIB}"; printf '%s' "$AGY_FAILURE_TAIL_LINES"`).stdout);
    expect(n).toBeGreaterThanOrEqual(20);
    expect(n).toBeLessThanOrEqual(80);
    // The error sits exactly at the edge of the window: still seen; one line further: not.
    const edge = `Error: timeout waiting for response\n${noise(n - 1)}\n`;
    const beyond = `Error: timeout waiting for response\n${noise(n)}\n`;
    expect(classify(edge)).toBe("transient");
    expect(classify(beyond)).toBe("unknown");
  });
});

describe("classify_agy_failure — a bare status counts only in an HTTP/status/code context", () => {
  const ACCEPT: readonly (readonly [string, Klass])[] = [
    ["Error: HTTP 401 while calling the API", "auth"],
    ["error: HTTP/1.1 403 Forbidden", "auth"],
    ["error: status: 401", "auth"],
    ['error: {"code": 403, "message": "denied"}', "auth"],
    ["Error: request failed, status code 429", "transient"],
    ["error: HTTP/2 500", "transient"],
    ["Error: server said HTTP 502", "transient"],
    ["Error: code=504 gateway timeout", "transient"],
    ["Error: status 503", "transient"],
  ];

  it.each(ACCEPT)("accepts %s as %s [synthetic]", (line, klass) => {
    expect(classify(`${line}\n`)).toBe(klass);
  });

  it("does not read 4010 or 5030 as 401 or 503 (word boundary) [synthetic]", () => {
    expect(classify("Error: status 4010\n")).toBe("unknown");
    expect(classify("Error: HTTP 5030\n")).toBe("unknown");
  });
});

describe("agy_failure_line — the line that will be quoted to the founder", () => {
  const firstLine = (klass: Klass, text: string): string => {
    writeFileSync(logFile, text);
    return bash(`source "${LIB}"; agy_failure_line ${klass} "$1"`, [logFile]).stdout.replace(/\n$/, "");
  };

  it("is the FIRST matching error line in the tail, not a prose line that mentions the same words [synthetic]", () => {
    const text = [
      "I will make the client show 'please log in' on a 401.",
      "error: UNAUTHENTICATED: first",
      "error: PERMISSION_DENIED: second",
    ].join("\n");
    expect(firstLine("auth", text)).toBe("error: UNAUTHENTICATED: first");
  });

  it("prints nothing when the class does not match", () => {
    expect(firstLine("auth", "Error: something else broke\n")).toBe("");
  });
});

describe("agy_patterns", () => {
  it.each(["quota", "auth", "transient"] as const)("%s has a non-empty pattern list with no blank entries", (klass) => {
    const patterns = patternsOf(klass);
    expect(patterns.length).toBeGreaterThan(0);
    for (const p of patterns) expect(p.trim()).not.toBe("");
  });

  it("an unknown class name is an error, not an empty list that would classify nothing silently", () => {
    const r = bash(`source "${LIB}"; agy_patterns nonsense`);
    expect(r.status).not.toBe(0);
  });
});
