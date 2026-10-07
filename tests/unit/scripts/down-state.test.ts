/**
 * The shared pause/resume state machine — deploy/lib/down-state.sh.
 * ================================================================
 * pr-brain already had one: an outage is ONE Telegram message going down and ONE
 * coming back, never one per tick (2026-09-26/27: a usage limit produced 72
 * "Gate FAILED" messages a day). agent-dispatch had none: a startup failure was
 * logged and repeated every 15 minutes, an expired Antigravity login killed the
 * issue as agent:failed. Both daemons now source this file, so the transitions are
 * pinned once, here, against the real functions.
 *
 * Every secret-shaped string in these tests is assembled at run time from pieces:
 * a contiguous fake key in the source would trip secret scanning on push.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB = fileURLToPath(new URL("../../../deploy/lib/down-state.sh", import.meta.url));

let root: string;
let home: string;

/** Synthetic secrets, built at run time (see header). None of these is a real credential. */
const FAKE = {
  google: "AI" + "za" + "Sy" + "b".repeat(33),
  skProj: "sk-" + "proj-" + "q".repeat(40),
  skAnt: "sk-" + "ant-api03-" + "Z".repeat(30),
  ghp: "gh" + "p_" + "y".repeat(36),
  telegram: "123456789" + ":" + "Z".repeat(35),
  slack: "xox" + "b-" + "1234567890-abcdefghij",
  jwt: "ey" + "J" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkw" + "." + "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV",
  hex40: "0123456789abcdef".repeat(2) + "01234567",
  odd: "weird-KEY_value.with.dots/and+slashes==",
};

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `body` in bash with the library sourced and log()/notify() recording to files. */
function run(body: string, env: Record<string, string> = {}): Ran {
  const script = `
set -uo pipefail
log() { printf '%s\\n' "$*" >>"$TEST_LOG"; }
notify() { printf '%s\\n@@\\n' "$1" >>"$TEST_SENDS"; return "\${NOTIFY_RC:-0}"; }
DOWN_FILE="$HOME/.claude/test.down"
mkdir -p "$HOME/.claude"
source "${LIB}"
${body}
`;
  const r = spawnSync("bash", ["-c", script], {
    env: {
      TG_QUIET_NOW: "12", // daytime: notify must not depend on when CI runs
      PATH: "/usr/bin:/bin:/usr/local/bin",
      HOME: home,
      TEST_LOG: join(root, "log.txt"),
      TEST_SENDS: join(root, "sends.txt"),
      ...env,
    },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const sends = (): string[] =>
  existsSync(join(root, "sends.txt"))
    ? readFileSync(join(root, "sends.txt"), "utf8").split("\n@@\n").filter((s) => s.trim() !== "")
    : [];
const downFile = () => join(home, ".claude", "test.down");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "down-state-"));
  home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("down-state — the transitions", () => {
  it("running -> down: writes the class and time, sends ONE message", () => {
    const r = run(`down_enter auth "key rejected" "PAUSED: fix the key"`);

    expect(r.status).toBe(0);
    const lines = readFileSync(downFile(), "utf8").split("\n");
    expect(lines[0]).toBe("auth");
    expect(lines[1]).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
    expect(sends()).toEqual(["PAUSED: fix the key"]);
  });

  it("down -> down (same class): silent on every later tick, and the pause time is not rewritten", () => {
    run(`down_enter auth "key rejected" "PAUSED: fix the key"`);
    const since = readFileSync(downFile(), "utf8").split("\n")[1];
    for (let i = 0; i < 5; i++) run(`down_enter auth "key rejected" "PAUSED: fix the key"`);

    expect(sends()).toHaveLength(1);
    expect(readFileSync(downFile(), "utf8").split("\n")[1]).toBe(since);
  });

  it("down -> down (a DIFFERENT class): one new message, the state names the new class", () => {
    run(`down_enter gh-auth "gh logged out" "PAUSED: gh"`);
    run(`down_enter auth "key rejected" "PAUSED: key"`);
    run(`down_enter auth "key rejected" "PAUSED: key"`);

    expect(sends()).toEqual(["PAUSED: gh", "PAUSED: key"]);
    expect(readFileSync(downFile(), "utf8").split("\n")[0]).toBe("auth");
  });

  it("down -> resumed (down_leave): removes the state, sends ONE message, and is silent after", () => {
    run(`down_enter auth "key rejected" "PAUSED: key"`);
    run(`down_leave "RESUMED"`);
    run(`down_leave "RESUMED"`);

    expect(existsSync(downFile())).toBe(false);
    expect(sends()).toEqual(["PAUSED: key", "RESUMED"]);
  });

  it("down_leave with no state at all is silent (a healthy tick must never announce a resume)", () => {
    const r = run(`down_leave "RESUMED"`);
    expect(r.status).toBe(0);
    expect(sends()).toEqual([]);
  });

  it("down -> resumed by the founder deleting the file: down_reap_removed sends ONE message, then none", () => {
    run(`down_enter auth "key rejected" "PAUSED: key"`);
    rmSync(downFile());

    run(`down_reap_removed "RESUMED (file removed)"`);
    run(`down_reap_removed "RESUMED (file removed)"`);

    expect(sends()).toEqual(["PAUSED: key", "RESUMED (file removed)"]);
  });

  it("down_reap_removed is silent while the state file is still there", () => {
    run(`down_enter auth "key rejected" "PAUSED: key"`);
    run(`down_reap_removed "RESUMED (file removed)"`);
    expect(sends()).toEqual(["PAUSED: key"]);
  });

  it("carries an opaque extra line (agent-dispatch stores the key file's mtime there)", () => {
    run(`down_enter auth "key rejected" "PAUSED: key" "1758000000"`);
    const r = run(`down_class; down_extra`);
    expect(r.stdout.split("\n").slice(0, 2)).toEqual(["auth", "1758000000"]);
  });

  it("a Telegram failure changes nothing: the state is still written and still cleared", () => {
    const enter = run(`down_enter auth "key rejected" "PAUSED: key"`, { NOTIFY_RC: "22" });
    expect(enter.status).toBe(0);
    expect(existsSync(downFile())).toBe(true);

    // With Telegram still down, the next ticks stay silent rather than retrying the message.
    run(`down_enter auth "key rejected" "PAUSED: key"`, { NOTIFY_RC: "22" });
    expect(sends()).toHaveLength(1);

    run(`down_leave "RESUMED"`, { NOTIFY_RC: "22" });
    expect(existsSync(downFile())).toBe(false);
  });

  it("creates the state directory when it does not exist yet", () => {
    rmSync(join(home, ".claude"), { recursive: true });
    const r = run(`rmdir "$HOME/.claude"; down_enter auth "x" "PAUSED"`);
    expect(r.status).toBe(0);
    expect(existsSync(downFile())).toBe(true);
  });

  it("does not announce a pause it could not record (that would repeat every tick)", () => {
    // The state path is a directory, so the write fails.
    mkdirSync(downFile());
    const r = run(`down_enter auth "key rejected" "PAUSED: key"`);
    expect(r.status).toBe(0);
    expect(sends()).toEqual([]);
    expect(readFileSync(join(root, "log.txt"), "utf8")).toMatch(/could not record/);
  });
});

describe("down-state — redact_secrets (everything that leaves the box passes through it)", () => {
  const redact = (input: string, extra = ""): string =>
    run(`${extra}\nredact_secrets <<<"$INPUT"`, { INPUT: input }).stdout.trimEnd();

  it.each([
    ["a Google API key", `Error: API key not valid: ${FAKE.google}`, FAKE.google],
    ["an sk-proj key", `auth failed for ${FAKE.skProj}`, FAKE.skProj],
    ["an sk-ant key", `auth failed for ${FAKE.skAnt}`, FAKE.skAnt],
    ["a GitHub token", `gh: bad credentials ${FAKE.ghp}`, FAKE.ghp],
    ["a Telegram bot token", `POST https://api.telegram.org/bot${FAKE.telegram}/sendMessage failed`, FAKE.telegram],
    ["a Slack token", `slack said no to ${FAKE.slack}`, FAKE.slack],
    ["a JWT", `token ${FAKE.jwt} expired`, FAKE.jwt],
    ["a 40-char hex string", `hmac ${FAKE.hex40} mismatch`, FAKE.hex40],
  ])("masks %s", (_label, line, secret) => {
    const out = redact(line);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it("masks a Bearer credential but keeps the word Bearer, so the line still says what failed", () => {
    const out = redact(`request failed: Authorization: Bearer ${FAKE.jwt}`);
    expect(out).toContain("Bearer [REDACTED]");
    expect(out).not.toContain(FAKE.jwt);
  });

  it("masks the value of key=, api_key: and GOOGLE_GENERATIVE_AI_API_KEY= forms, keeping the name", () => {
    const out = redact(`GET /v1beta/models?key=${FAKE.odd}&alt=json; GOOGLE_GENERATIVE_AI_API_KEY=${FAKE.odd}`);
    expect(out).not.toContain(FAKE.odd);
    expect(out).toContain("key=[REDACTED]");
    expect(out).toContain("GOOGLE_GENERATIVE_AI_API_KEY=[REDACTED]");
  });

  it("masks the exact known secret even when it matches no shape (REDACT_LITERALS)", () => {
    const out = redact(`the model said: ${FAKE.odd} is wrong`, `REDACT_LITERALS+=("${FAKE.odd}")`);
    expect(out).not.toContain(FAKE.odd);
    expect(out).toContain("the model said: [REDACTED] is wrong");
  });

  it("never puts a literal secret on any command line (it travels in the environment / shell only)", () => {
    // If the literal were passed to sed/awk as an argument, /proc/<pid>/cmdline would show it.
    // A fake `sed`/`awk` on PATH records its argv; the run must leave neither holding the secret.
    const bin = join(root, "bin");
    mkdirSync(bin, { recursive: true });
    for (const tool of ["sed", "awk", "grep", "tr", "cat"]) {
      // macOS keeps cat in /bin only; Linux (usrmerge) has both.
      const real = existsSync(`/usr/bin/${tool}`) ? `/usr/bin/${tool}` : `/bin/${tool}`;
      writeFileSync(
        join(bin, tool),
        `#!/bin/bash\nprintf '%s\\n' "$*" >>"${join(root, "argv.txt")}"\nexec ${real} "$@"\n`,
        { mode: 0o755 },
      );
    }
    const r = run(`REDACT_LITERALS+=("${FAKE.odd}")\nredact_secrets <<<"x ${FAKE.odd} y"`, {
      PATH: `${bin}:/usr/bin:/bin`,
    });
    expect(r.stdout).toContain("x [REDACTED] y");
    expect(r.stdout).not.toContain(FAKE.odd);
    const argv = existsSync(join(root, "argv.txt")) ? readFileSync(join(root, "argv.txt"), "utf8") : "";
    expect(argv).not.toContain(FAKE.odd);
  });

  it("leaves ordinary failure text alone: the quota line, a status line, a short word run", () => {
    const quota =
      "error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 57h37m44s.";
    expect(redact(quota)).toBe(quota);
    expect(redact("HTTP 401: Bad credentials")).toBe("HTTP 401: Bad credentials");
    expect(redact("Error: timeout waiting for response")).toBe("Error: timeout waiting for response");
  });

  it("does not eat a word that merely ends in sk- (risk-assessment-framework)", () => {
    expect(redact("see risk-assessment-framework for details")).toBe("see risk-assessment-framework for details");
  });

  it("masks a long mixed-case token nobody has a pattern for (the generic long-token rule)", () => {
    const token = "aB3" + "xY9".repeat(12);
    const out = redact(`session ${token} rejected`);
    expect(out).toBe("session [REDACTED] rejected");
  });

  it("keeps a long kebab-case branch name and a long snake_case file name readable", () => {
    // Over-redacting these would make every quoted log tail useless to the founder.
    const branch = "task/issue-710-test-docs-add-visible-test-comment";
    const file = "some_very_long_test_file_name_for_the_thing.test.ts";
    expect(redact(`checked out ${branch} and ran ${file}`)).toBe(`checked out ${branch} and ran ${file}`);
  });

  it("does not treat a literal shorter than 8 characters as a secret (it would mangle the message)", () => {
    const out = redact("the word short appears here", `REDACT_LITERALS+=("short")`);
    expect(out).toBe("the word short appears here");
  });

  it("down_enter and down_leave redact what they announce, by construction", () => {
    run(`down_enter auth "x" "PAUSED: rejected ${FAKE.google}"`);
    run(`down_leave "RESUMED with ${FAKE.google}"`);
    expect(sends()).toEqual(["PAUSED: rejected [REDACTED]", "RESUMED with [REDACTED]"]);
  });
});
