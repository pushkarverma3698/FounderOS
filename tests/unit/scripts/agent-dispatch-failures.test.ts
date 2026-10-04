/**
 * agent-dispatch fails loud and never dies silently — deploy/agent-dispatch.
 * ===========================================================================
 * Measured 2026-09-29: the loop ran mechanically and shipped nothing. Every failure that
 * was not a quota wall ended the same way, agent:failed or a log line, so the founder
 * could not tell "broken" from "idle" from "paused":
 *   - an expired Antigravity login killed the issue for good (agent:failed is terminal);
 *   - `Error: timeout waiting for response` (seen 3 times) did the same;
 *   - a startup failure (gh logged out, agy missing) was logged every 15 minutes and
 *     never reached Telegram;
 *   - the Gemini key was on the process command line for the length of every run.
 *
 * These run the real script in the deployed layout against the shared sandbox. Every log
 * line an Antigravity run prints here is labelled: "verbatim" when the plan or an existing
 * test quotes it, "synthetic" otherwise. No real auth failure has been observed yet.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DispatchSandbox, FAKE_GEMINI_KEY } from "./dispatch-sandbox.js";

const QUOTA_LINE =
  "error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 57h37m44s."; // verbatim
const AUTH_LINE = "Error: 403 PERMISSION_DENIED: The caller does not have permission"; // synthetic
const TRANSIENT_LINE = "Error: timeout waiting for response"; // verbatim
const DOWN = "agent-dispatch.down";

/** DEFAULT_REPOS as the real script declares it (the same one-line format the serviceability test parses). */
function defaultRepos(): string[] {
  const src = readFileSync(fileURLToPath(new URL("../../../deploy/agent-dispatch", import.meta.url)), "utf8");
  const line = /^DEFAULT_REPOS=\((.*)\)$/m.exec(src);
  if (!line?.[1]) throw new Error("deploy/agent-dispatch no longer declares DEFAULT_REPOS=( … ) on one line");
  return [...line[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
}

let sb: DispatchSandbox;

const paused = () => sb.messages().filter((m) => /PAUSED/.test(m));
const resumed = () => sb.messages().filter((m) => /resumed/i.test(m));
const nowSec = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  sb = new DispatchSandbox(["owner/founderos"]);
  sb.addIssue({ number: 710, title: "test(docs): add visible test comment" });
});

afterEach(() => {
  sb.destroy();
});

describe("Antigravity auth failure", () => {
  it("puts the issue back to agent:ready (never agent:failed), pauses the loop, and sends ONE message with the fix", () => {
    sb.tick({ agyOut: `${"I am working on it.\n".repeat(5)}${AUTH_LINE}` });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.labelsOf(710)).toEqual(["agent:ready"]);
    expect(sb.ghLog()).not.toMatch(/agent:failed/);
    expect(sb.readState(DOWN).split("\n")[0]).toBe("auth");

    const msgs = paused();
    expect(sb.messages()).toHaveLength(1);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain(`Antigravity auth failed: ${AUTH_LINE}`);
    expect(msgs[0]).toContain("Fix:");
    expect(msgs[0]).toContain("GOOGLE_GENERATIVE_AI_API_KEY");
    expect(msgs[0]).toContain(sb.envFile);
    expect(msgs[0]).toContain("rm ~/.claude/agent-dispatch.down");
    expect(msgs[0]).toMatch(/one more message when it resumes/i);
  });

  it("says so on the issue too, once, so the board and Telegram agree", () => {
    sb.tick({ agyOut: AUTH_LINE });

    const notes = sb.commentsOf(710).filter((c) => /credentials|auth failed/i.test(c));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("agent:ready");
    expect(notes[0]).toContain(AUTH_LINE);
  });

  it("claims NOTHING on later ticks, and stays silent (down -> down)", () => {
    sb.tick({ agyOut: AUTH_LINE });
    for (let i = 0; i < 4; i++) sb.tick({ agyOut: AUTH_LINE });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.messages()).toHaveLength(1);
    expect(sb.log()).toMatch(/paused \(auth/);
    expect(sb.labelsOf(710)).toEqual(["agent:ready"]);
  });

  it("exits 0 while paused: a handled state is not a cron failure", () => {
    sb.tick({ agyOut: AUTH_LINE });
    expect(sb.tick({ agyOut: AUTH_LINE }).status).toBe(0);
  });

  it("resumes when the founder deletes the down file: ONE 'resumed' message, then it claims again", () => {
    sb.tick({ agyOut: AUTH_LINE });
    rmSync(sb.statePath(DOWN));

    sb.tick({ agyOut: TRANSIENT_LINE });
    sb.tick({ agyOut: TRANSIENT_LINE });

    expect(sb.agyRuns()).toBe(3);
    expect(resumed()).toHaveLength(1);
    expect(paused()).toHaveLength(1);
    expect(resumed()[0]).toMatch(/removed by hand/i);
  });

  it("resumes when the key file's mtime changes (key rotated while paused): ONE 'resumed' message", () => {
    sb.tick({ agyOut: AUTH_LINE });
    expect(sb.hasState(DOWN)).toBe(true);

    sb.touchEnvFile(nowSec() + 5);
    sb.tick({ agyOut: TRANSIENT_LINE });
    sb.tick({ agyOut: TRANSIENT_LINE });

    expect(sb.hasState(DOWN)).toBe(false);
    expect(sb.agyRuns()).toBe(3);
    expect(resumed()).toHaveLength(1);
    expect(resumed()[0]).toContain(sb.envFile);
    expect(paused()).toHaveLength(1);
  });

  it("stays paused while the key file is untouched, however many ticks pass", () => {
    sb.tick({ agyOut: AUTH_LINE });
    sb.tick({ agyOut: TRANSIENT_LINE });
    sb.tick({ agyOut: TRANSIENT_LINE });
    expect(sb.hasState(DOWN)).toBe(true);
    expect(sb.agyRuns()).toBe(1);
    expect(resumed()).toHaveLength(0);
  });

  it("notices a key rotated DURING the failing run: the mtime recorded is the one at start", () => {
    sb.tick({
      agyOut: AUTH_LINE,
      // The founder pastes the new key while agy is still running with the old one.
      agyHook: 'printf "\\n" >>"$AGENT_DISPATCH_ENV_FILE"',
    });
    expect(sb.hasState(DOWN)).toBe(true);

    sb.tick({ agyOut: TRANSIENT_LINE });

    expect(sb.agyRuns()).toBe(2); // resumed on the very next tick, without anyone deleting anything
    expect(resumed()).toHaveLength(1);
  });

  it("a second auth failure after a resume sends a second, separate pause message", () => {
    sb.tick({ agyOut: AUTH_LINE });
    rmSync(sb.statePath(DOWN));
    sb.tick({ agyOut: AUTH_LINE });

    expect(paused()).toHaveLength(2);
    expect(resumed()).toHaveLength(1);
  });

  it("quota wins when the same log carries both: the quota wall is recorded, the loop is NOT paused [verbatim quota + synthetic auth]", () => {
    sb.tick({ agyOut: `${AUTH_LINE}\n${QUOTA_LINE}` });

    expect(sb.hasState("agent-dispatch.quota-until")).toBe(true);
    expect(sb.hasState(DOWN)).toBe(false);
    expect(sb.labelsOf(710)).toEqual(["agent:ready"]);
    expect(sb.messages().join("\n")).toMatch(/quota/i);
    expect(paused()).toHaveLength(0);
  });

  it("a Telegram outage changes no dispatch state and causes no retry storm", () => {
    sb.tick({ agyOut: AUTH_LINE, curlRc: 22 });
    sb.tick({ agyOut: AUTH_LINE, curlRc: 22 });
    sb.tick({ agyOut: AUTH_LINE, curlRc: 22 });

    expect(sb.labelsOf(710)).toEqual(["agent:ready"]);
    expect(sb.readState(DOWN).split("\n")[0]).toBe("auth");
    expect(sb.agyRuns()).toBe(1);
    // One attempted pause message, and no further sends on the ticks that followed.
    expect(sb.messages()).toHaveLength(1);
  });
});

describe("a re-dispatch is in progress (the PR exists) and Antigravity's login fails", () => {
  const BRANCH = "task/issue-710-test-docs-add-visible-test-comment";
  const SHA = "b".repeat(40);

  beforeEach(() => {
    sb.ensureRemoteBranch("owner/founderos", BRANCH);
    sb.addIssue({ number: 710, title: "test(docs): add visible test comment", labels: ["agent:review"] });
    sb.addPr({ number: 11, headRefName: BRANCH, headRefOid: SHA, isDraft: true, comments: [`<!-- brain-reviewed: ${SHA} -->`] });
  });

  it("leaves the PR open, does not count the attempt, and writes the down file", () => {
    sb.tick({ agyOut: AUTH_LINE });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.readState(DOWN).split("\n")[0]).toBe("auth");
    expect(sb.prCommentsOf(11).some((c) => c.startsWith("<!-- agent-attempt:"))).toBe(false);
    expect(sb.ghLog()).not.toMatch(/pr close|pr merge|--state closed/);
    expect(sb.prs()).toHaveLength(1);
    expect(sb.labelsOf(710)).toEqual(["agent:review"]);
    expect(paused()).toHaveLength(1);
  });

  it("does not re-dispatch again while paused", () => {
    sb.tick({ agyOut: AUTH_LINE });
    sb.tick({ agyOut: AUTH_LINE });
    sb.tick({ agyOut: AUTH_LINE });

    expect(sb.agyRuns()).toBe(1);
    expect(sb.messages()).toHaveLength(1);
  });
});

describe("the Gemini key never reaches a command line, a log, Telegram or GitHub", () => {
  it("is not in the argv of any sudo call, but the fake agy still receives it in its environment", () => {
    sb.tick({ agyOut: "Error: something else broke" });

    expect(sb.agyKeysSeen()).toEqual([FAKE_GEMINI_KEY]);
    const calls = sb.sudoCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).not.toContain(FAKE_GEMINI_KEY);
  });

  it("reads the key off stdin inside the sudo'd shell (the script text says so)", () => {
    sb.tick({ agyOut: "Error: something else broke" });

    const agyCall = sb.sudoCalls().find((c) => c.includes("--print-timeout"));
    expect(agyCall).toBeDefined();
    expect(agyCall).toMatch(/read -r GEMINI_API_KEY/);
    expect(agyCall).not.toMatch(/export GEMINI_API_KEY="\$3"/);
  });

  it("stays out of the daemon's log and state even when agy itself prints it", () => {
    sb.tick({ agyOut: `debug: request used key ${FAKE_GEMINI_KEY}\nError: something else broke` });

    expect(sb.log()).not.toContain(FAKE_GEMINI_KEY);
    expect(sb.allStateText()).not.toContain(FAKE_GEMINI_KEY);
    expect(sb.log()).toContain("[REDACTED]");
  });

  it("is redacted from the quoted auth line in Telegram AND in the GitHub comment (shape-based)", () => {
    sb.tick({ agyOut: `Error: API key not valid: ${FAKE_GEMINI_KEY}` });

    const everywhere = [...sb.messages(), ...sb.commentsOf(710), sb.log()].join("\n");
    expect(everywhere).not.toContain(FAKE_GEMINI_KEY);
    expect(sb.messages()[0]).toContain("Antigravity auth failed: Error: API key not valid: [REDACTED]");
  });

  it("is redacted even when it has no recognisable shape (the exact configured value is masked)", () => {
    const odd = "weird-KEY_value.with.dots/and+slashes==";
    sb.writeEnvFile(`TELEGRAM_BOT_TOKEN=x\nTELEGRAM_CHAT_ID=1\nGOOGLE_GENERATIVE_AI_API_KEY=${odd}\n`);
    sb.tick({ agyOut: `Error: PERMISSION_DENIED for credential ${odd}` });

    const everywhere = [...sb.messages(), ...sb.commentsOf(710), sb.log(), ...sb.sudoCalls()].join("\n");
    expect(everywhere).not.toContain(odd);
    expect(sb.agyKeysSeen()).toEqual([odd]);
  });

  it("is redacted from the LIVE progress message too, which is edited into Telegram while agy runs", () => {
    // The progress message shows tool calls, and a tool call's command line can hold the key (an agent that
    // `export`s it, or curls with it). agy stays alive for a second after printing so the loop renders it.
    const toolCall = JSON.stringify({
      event: "step_update",
      step_update: {
        conversation_id: "c",
        step_index: 2,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: `curl -H "x-goog-api-key: ${FAKE_GEMINI_KEY}" https://example.test` } },
      },
    });
    sb.tick({ agyOut: toolCall, agySleepAfter: 1 });

    const edits = sb.telegram().filter((c) => c.kind === "edit");
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.map((c) => c.text).join("\n")).toContain("[REDACTED]");
    const everything = [...sb.telegram().map((c) => c.text), sb.log()].join("\n");
    expect(everything).not.toContain(FAKE_GEMINI_KEY);
  });

  it("is redacted from the tails posted on a failed issue", () => {
    sb.tick({ agyOut: `debug: key=${FAKE_GEMINI_KEY}\nError: something else broke` });

    expect(sb.commentsOf(710).join("\n")).not.toContain(FAKE_GEMINI_KEY);
  });
});

describe("transient failures are retried, and the third gives up", () => {
  const MARKER = (n: number) => `<!-- agent-transient: ${n} -->`;

  it("the first puts the issue back to agent:ready with a marker, silently, and does not pause or back off", () => {
    sb.tick({ agyOut: TRANSIENT_LINE });

    expect(sb.labelsOf(710)).toEqual(["agent:ready"]);
    expect(sb.commentsOf(710).filter((c) => c.startsWith(MARKER(1)))).toHaveLength(1);
    expect(sb.ghLog()).not.toMatch(/agent:failed/);
    expect(sb.messages()).toEqual([]);
    expect(sb.hasState(DOWN)).toBe(false);
    expect(sb.hasState("agent-dispatch.quota-until")).toBe(false);
  });

  it("the second is retried too (marker 2)", () => {
    sb.tick({ agyOut: TRANSIENT_LINE });
    sb.tick({ agyOut: TRANSIENT_LINE });

    expect(sb.labelsOf(710)).toEqual(["agent:ready"]);
    expect(sb.commentsOf(710).filter((c) => c.startsWith(MARKER(2)))).toHaveLength(1);
    expect(sb.agyRuns()).toBe(2);
  });

  it("the THIRD goes to agent:failed with all three log tails in ONE comment and one Telegram message", () => {
    for (let i = 1; i <= 3; i++) sb.tick({ agyOut: `narration of attempt ${i}\n${TRANSIENT_LINE}` });

    expect(sb.labelsOf(710)).toEqual(["agent:failed"]);
    const final = sb.commentsOf(710).filter((c) => c.startsWith(MARKER(3)));
    expect(final).toHaveLength(1);
    for (let i = 1; i <= 3; i++) expect(final[0]).toContain(`narration of attempt ${i}`);
    const msgs = sb.messages();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/#710 FAILED after 3 transient/);
    expect(sb.agyRuns()).toBe(3);
  });

  it("a fourth tick does not touch a failed issue", () => {
    for (let i = 1; i <= 3; i++) sb.tick({ agyOut: TRANSIENT_LINE });
    sb.tick({ agyOut: TRANSIENT_LINE });

    expect(sb.agyRuns()).toBe(3);
    expect(sb.labelsOf(710)).toEqual(["agent:failed"]);
  });

  it("counts from the markers already on the issue, so the count survives a daemon restart", () => {
    sb.addIssue({
      number: 710,
      comments: [`${MARKER(1)} earlier\n\`\`\`\ntail of attempt one\n\`\`\``, `${MARKER(2)} earlier\n\`\`\`\ntail of attempt two\n\`\`\``],
    });
    sb.tick({ agyOut: `tail of attempt three\n${TRANSIENT_LINE}` });

    expect(sb.labelsOf(710)).toEqual(["agent:failed"]);
    const final = sb.commentsOf(710).find((c) => c.startsWith(MARKER(3))) ?? "";
    expect(final).toContain("tail of attempt one");
    expect(final).toContain("tail of attempt two");
    expect(final).toContain("tail of attempt three");
  });

  it("'timeout: failed to execute process' is transient too [verbatim]", () => {
    sb.tick({ agyOut: "timeout: failed to execute process" });
    expect(sb.labelsOf(710)).toEqual(["agent:ready"]);
    expect(sb.commentsOf(710).some((c) => c.startsWith(MARKER(1)))).toBe(true);
  });

  it("an ordinary failure is still agent:failed on the FIRST run, with a message [verbatim: the existing test's line]", () => {
    sb.tick({ agyOut: "Error: something else broke" });

    expect(sb.labelsOf(710)).toEqual(["agent:failed"]);
    expect(sb.messages()).toHaveLength(1);
    expect(sb.messages()[0]).toMatch(/#710 FAILED/);
  });
});

describe("a startup failure is announced ONCE, then silence until it recovers", () => {
  it("gh logged out: one PAUSED message naming the fix, nothing on the next 4 ticks, ONE resumed message on recovery", () => {
    sb.patchGh({ authOk: false });
    for (let i = 0; i < 5; i++) expect(sb.tick({ agyOut: TRANSIENT_LINE }).status).toBe(0);

    expect(sb.messages()).toHaveLength(1);
    expect(sb.messages()[0]).toContain("PAUSED");
    expect(sb.messages()[0]).toMatch(/gh auth login/);
    expect(sb.agyRuns()).toBe(0);
    expect(sb.readState(DOWN).split("\n")[0]).toBe("gh-auth");

    sb.patchGh({ authOk: true });
    sb.tick({ agyOut: TRANSIENT_LINE });
    sb.tick({ agyOut: TRANSIENT_LINE });

    expect(resumed()).toHaveLength(1);
    expect(sb.hasState(DOWN)).toBe(false);
    expect(sb.agyRuns()).toBe(2);
  });

  it("a missing dependency names the tool and the install command", () => {
    for (let i = 0; i < 3; i++) sb.tick({ withoutTools: ["jq"] });

    expect(sb.messages()).toHaveLength(1);
    expect(sb.messages()[0]).toContain("'jq' is not installed");
    expect(sb.messages()[0]).toMatch(/apt-get install -y jq/);
    expect(sb.readState(DOWN).split("\n")[0]).toBe("missing-dep");
  });

  it("agy missing for the antigravity user is announced once, and resumes when it is back", () => {
    for (let i = 0; i < 3; i++) sb.tick({ noAgy: true });

    expect(sb.messages()).toHaveLength(1);
    expect(sb.messages()[0]).toMatch(/Antigravity CLI \(agy\) is not on the PATH of user/);
    expect(sb.readState(DOWN).split("\n")[0]).toBe("agy-missing");

    sb.tick({ agyOut: TRANSIENT_LINE });
    expect(resumed()).toHaveLength(1);
    expect(sb.hasState(DOWN)).toBe(false);
  });

  it("a DIFFERENT startup failure is a new transition: one more message", () => {
    sb.patchGh({ authOk: false });
    sb.tick();
    sb.tick({ noAgy: true }); // still logged out: gh is checked first, so the class does not change
    expect(sb.messages()).toHaveLength(1);

    sb.patchGh({ authOk: true });
    sb.tick({ noAgy: true }); // gh recovered, agy is missing
    expect(sb.readState(DOWN).split("\n")[0]).toBe("agy-missing");
    expect(sb.messages().filter((m) => /PAUSED/.test(m))).toHaveLength(2);
  });

  it("--dry-run and --list touch nothing: they fail as before (exit 1), with no Telegram and no state file", () => {
    sb.patchGh({ authOk: false });

    const dry = sb.tick({ args: ["--dry-run"] });
    const list = sb.tick({ args: ["--list"] });

    expect(dry.status).toBe(1);
    expect(list.status).toBe(1);
    expect(sb.messages()).toEqual([]);
    expect(sb.hasState(DOWN)).toBe(false);
  });

  it("a healthy tick with no down state never announces a resume", () => {
    sb.tick({ agyOut: TRANSIENT_LINE });
    sb.tick({ agyOut: TRANSIENT_LINE });
    expect(resumed()).toHaveLength(0);
  });
});

describe("the repo list: DEFAULT_REPOS is the only one the daemon reads", () => {
  it("ignores ISSUE_REPOS from the environment and logs ONE warning per tick that names the fix", () => {
    sb.tick({ env: { ISSUE_REPOS: "attacker/elsewhere owner/founderos" }, agyOut: TRANSIENT_LINE });
    sb.tick({ env: { ISSUE_REPOS: "attacker/elsewhere owner/founderos" }, agyOut: TRANSIENT_LINE });

    const warnings = sb.log().split("\n").filter((l) => /WARNING: ISSUE_REPOS/.test(l));
    expect(warnings).toHaveLength(2); // one per tick
    expect(warnings[0]).toMatch(/IGNORED/);
    expect(warnings[0]).toMatch(/crontab -e/);
    expect(warnings[0]).toMatch(/delete/i);
    expect(sb.ghLog()).not.toContain("attacker/elsewhere");
  });

  it("does the same for the older singular ISSUE_REPO", () => {
    sb.tick({ env: { ISSUE_REPO: "attacker/elsewhere" }, agyOut: TRANSIENT_LINE });

    expect(sb.log()).toMatch(/WARNING: ISSUE_REPO is set/);
    expect(sb.ghLog()).not.toContain("attacker/elsewhere");
  });

  it("says nothing when neither is set", () => {
    sb.tick({ agyOut: TRANSIENT_LINE });
    expect(sb.log()).not.toMatch(/WARNING: ISSUE_REPO/);
  });
});

describe("the real file, in the repo layout (helpers in deploy/lib)", () => {
  it("--help works from deploy/ with no VPS state, so a missing helper cannot hide", () => {
    const r = sb.runInPlace(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/agent-dispatch/);
  });

  it("--list names every repo in DEFAULT_REPOS, read from the script itself", () => {
    const r = sb.runInPlace(["--list"]);
    const listed = [...r.stdout.matchAll(/agent:ready issues in (\S+):/g)].map((m) => m[1]);
    expect(defaultRepos().length).toBeGreaterThanOrEqual(4);
    expect(listed).toEqual(defaultRepos());
  });

  it("refuses to run without its helper libraries, loudly, and names where it looked", () => {
    rmSync(sb.installDir + "/lib", { recursive: true });
    const r = sb.tick({ args: ["--help"] });

    expect(r.status).toBe(1);
    expect(sb.log()).toMatch(/FATAL: lib\/.*\.sh not found/);
    expect(sb.log()).toMatch(/sync-daemons/);
  });
});

describe("agent-dispatch — Telegram quiet hours", () => {
  it("a login failure is urgent: it is sent at 02:00 and nothing is queued for the digest", () => {
    sb.tick({ agyOut: `${"I am working on it.\n".repeat(5)}${AUTH_LINE}`, env: { TG_QUIET_NOW: "02" } });
    expect(paused()).toHaveLength(1);
    expect(existsSync(sb.home + "/.claude/tg-digest.queue")).toBe(false);
  });
});
