/**
 * One Antigravity turn, shown live — deploy/lib/agy-run.sh.
 * =========================================================
 * Both VPS daemons run agy through this library, and what the founder watches in Telegram while a task
 * runs is its output. Before it, the "progress" was the last line agy printed in text mode: on 2026-10-02
 * the founder watched "root agent idle; waiting up to 28m0s for 1 background task(s)", "</app_notification>"
 * and "- No new PR opened; no PR merged." stand in for what Antigravity was doing.
 *
 * The stream-json lines below are real agy 1.2.14 output (captured on the VPS 2026-10-02), trimmed:
 * `init`, one `step_update` per step (tool steps carry tool_name and parameters, ACTIVE then DONE), and a
 * closing `result` event with status SUCCESS or ERROR.
 *
 * What is pinned:
 *   - the live view shows the LAST tool calls, not narration, and survives a half-written last line;
 *   - one Telegram message per run, EDITED while it runs and never deleted;
 *   - the failure classifier still reads agy's own errors (stderr, and the result event's error);
 *   - a secret in a command line never reaches Telegram;
 *   - the Gemini key travels on stdin only, and no key is exported when there is none.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = fileURLToPath(new URL("../../../deploy/lib/", import.meta.url));
const FAKE_KEY = "AI" + "za" + "Sy" + "k".repeat(33);

const init = { event: "init", conversation_id: "c", init: { model: "gemini-3.6-flash-medium", cwd: "/w", tools: ["run_command"] } };
const step = (index: number, state: "ACTIVE" | "DONE", rest: Record<string, unknown>): Record<string, unknown> => ({
  event: "step_update",
  step_update: { conversation_id: "c", step_index: index, state, ...rest },
});
const tool = (index: number, state: "ACTIVE" | "DONE", name: string, parameters: Record<string, unknown>): Record<string, unknown> =>
  step(index, state, { step_type: "tool", tool_name: name, tool_info: { name, parameters, ...(state === "DONE" ? { output: "x".repeat(2000) } : {}) } });
const result = (status: "SUCCESS" | "ERROR", rest: Record<string, unknown> = {}): Record<string, unknown> => ({
  event: "result",
  result: { conversation_id: "c", status, response: "", duration_seconds: 4, num_turns: 1, ...rest },
});
const lines = (...events: Record<string, unknown>[]): string => events.map((e) => JSON.stringify(e)).join("\n") + "\n";

let root: string;
let stubs: string;

function stub(name: string, body: string): void {
  const p = join(stubs, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
}

/** Runs `script` with the two libraries sourced and the daemon-side names the library needs. */
function bash(script: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    "bash",
    [
      "-c",
      `log() { printf '%s\\n' "$*" >>"$LOGF"; }
ENV_FILE="$ENVF"; AG_USER=tester; PROGRESS_POLL_SEC=0
source "${LIB_DIR}down-state.sh"; source "${LIB_DIR}agy-run.sh"
${script}`,
    ],
    {
      env: {
        PATH: `${stubs}:/usr/bin:/bin:/usr/local/bin`,
        HOME: root,
        LOGF: join(root, "daemon.log"),
        ENVF: join(root, ".env"),
        SENDS: join(root, "telegram.log"),
        SUDO_ARGV: join(root, "sudo-argv.log"),
        AGY_ENV_LOG: join(root, "agy-env.log"),
        ...env,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function render(rawText: string, label = "Antigravity #44 · owner/app", started = "$(( $(date +%s) - 125 ))"): string {
  writeFileSync(join(root, "raw.jsonl"), rawText);
  return bash(`agy_progress_render "${join(root, "raw.jsonl")}" "${label}" gemini-3.6-flash-medium "${started}"`).stdout.replace(/\n$/, "");
}

interface TgCall {
  readonly kind: string;
  readonly id: string;
  readonly text: string;
}
function telegram(): TgCall[] {
  const f = join(root, "telegram.log");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n@@\n")
    .filter((s) => s.trim() !== "")
    .map((rec) => {
      const [head = "", ...rest] = rec.split("\t");
      const [kind = "", id = ""] = head.split(" ");
      return { kind, id, text: rest.join("\t") };
    });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agy-run-"));
  stubs = join(root, "stubs");
  mkdirSync(stubs, { recursive: true });
  writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=987654321:" + "T".repeat(35) + "\nTELEGRAM_CHAT_ID=1\n");
  // sudo -u USER -- bash -lc SCRIPT _ args...  ->  run it as ourselves, keeping stdin; the argv is recorded.
  stub("sudo", `printf '%s\\n' "$*" >>"$SUDO_ARGV"\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"`);
  stub("timeout", `shift; exec "$@"`);
  // The fake agy prints $AGY_OUT (stdout), $AGY_ERR (stderr), records the key it was given, then exits.
  stub(
    "agy",
    `printf '%s\\n' "\${GEMINI_API_KEY-<unset>}" >>"$AGY_ENV_LOG"
printf '%s' "\${AGY_OUT:-}"
printf '%s' "\${AGY_ERR:-}" >&2
sleep "\${AGY_SLEEP_AFTER:-0}"
exit "\${AGY_RC:-0}"`,
  );
  // One record per Telegram call: "<kind> <message_id>\t<text>\n@@\n". sendMessage answers with id 7.
  stub(
    "curl",
    `kind=""; text=""; mid=""
for a in "$@"; do case "$a" in
  */sendMessage) kind=send ;;
  */editMessageText) kind=edit ;;
  */deleteMessage) kind=delete ;;
  message_id=*) mid="\${a#message_id=}" ;;
  text=*) text="\${a#text=}" ;;
esac; done
printf '%s %s\\t%s\\n@@\\n' "$kind" "$mid" "$text" >>"$SENDS"
printf '{"ok":true,"result":{"message_id":7}}\\n'`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("agy_progress_render — what the founder reads while agy works", () => {
  it("a run with no events yet renders just its header (agy is still starting)", () => {
    const text = render("");
    expect(text).toBe("🔧 Antigravity #44 · owner/app\n⏱ 2m · gemini-3.6-flash-medium · 0 tool calls");
  });

  it("shows the last five tool calls with their state, never narration or tool output", () => {
    const text = render(
      lines(
        init,
        step(0, "DONE", { step_type: "user_input" }),
        tool(2, "ACTIVE", "view_file", { AbsolutePath: "/opt/agy-workspace/oplify-messaging-app/docs/antigravity/ISSUE-DRIVEN-CONTRACT.md" }),
        tool(2, "DONE", "view_file", { AbsolutePath: "/opt/agy-workspace/oplify-messaging-app/docs/antigravity/ISSUE-DRIVEN-CONTRACT.md" }),
        tool(3, "DONE", "run_command", { CommandLine: "git status" }),
        tool(4, "DONE", "grep_search", { Query: "getSessionStatus" }),
        tool(5, "DONE", "multi_replace_file_content", { TargetFile: "/opt/agy-workspace/oplify-messaging-app/src/api/services/auth.service.js" }),
        tool(6, "DONE", "run_command", { CommandLine: "npm test" }),
        tool(7, "ACTIVE", "run_command", { CommandLine: "git push origin task/issue-44" }),
        step(8, "ACTIVE", { step_type: "agent_response", text_delta: "I am waiting for the test suite" }),
      ),
    );

    // six tool calls were made; the window is the last FIVE, the first (the contract file) has scrolled off
    expect(text).toBe(
      [
        "🔧 Antigravity #44 · owner/app",
        "⏱ 2m · gemini-3.6-flash-medium · 6 tool calls",
        "",
        "✅ run git status",
        "✅ search getSessionStatus",
        "✅ edit src/api/services/auth.service.js",
        "✅ run npm test",
        "⏳ run git push origin task/issue-44",
        "💭 thinking…",
      ].join("\n"),
    );
    expect(text).not.toContain("I am waiting");
    expect(text).not.toContain("xxxx");
  });

  it("clips a long command and strips the workspace prefix from a path", () => {
    const long = `npm test -- ${"a".repeat(200)}`;
    const text = render(lines(init, tool(2, "DONE", "run_command", { CommandLine: long }), tool(3, "DONE", "view_file", { AbsolutePath: "/opt/agy-workspace/review/oplify-messaging-api/src/index.js" })));
    const body = text.split("\n").slice(3);
    expect(body[0]?.length).toBeLessThanOrEqual("✅ run ".length + 64);
    expect(body[0]?.endsWith("…")).toBe(true);
    expect(body[1]).toBe("✅ read src/index.js");
  });

  it("tolerates a half-written last line, which is what a poll in the middle of a write reads", () => {
    const raw = lines(init, tool(2, "DONE", "run_command", { CommandLine: "ls" })) + '{"event":"step_update","step_update":{"conversation_id":"c","step_ind';
    expect(render(raw)).toContain("✅ run ls");
  });

  it("tolerates lines that are not events (agy's own stderr lands in the same file)", () => {
    const raw = `[agy] warming up\n${lines(init, tool(2, "DONE", "run_command", { CommandLine: "ls" }))}not json at all\n`;
    expect(render(raw)).toContain("✅ run ls");
  });

  it("a finished run is marked ✅ on SUCCESS and ⚠️ on ERROR, and drops the thinking line", () => {
    expect(render(lines(init, tool(2, "DONE", "run_command", { CommandLine: "ls" }), result("SUCCESS", { response: "done" })))).toMatch(/^✅ Antigravity #44/);
    expect(render(lines(init, result("ERROR", { error: "authentication failed or timed out" })))).toMatch(/^⚠️ Antigravity #44/);
  });

  it("masks a secret in a command line (the Telegram message is the one place it must never reach)", () => {
    const text = render(lines(init, tool(2, "ACTIVE", "run_command", { CommandLine: `curl -H "x-goog-api-key: ${FAKE_KEY}" https://example.test` })));
    expect(text).not.toContain(FAKE_KEY);
    expect(text).toContain("[REDACTED]");
  });

  it("counts a single call in the singular", () => {
    expect(render(lines(init, tool(2, "DONE", "run_command", { CommandLine: "ls" })))).toContain("· 1 tool call\n");
  });

  it("says 'just started' inside the first minute, then whole minutes (the text changes at most once a minute)", () => {
    expect(render("", "x", "$(date +%s)")).toContain("⏱ just started");
    expect(render("", "x", "$(( $(date +%s) - 3 * 60 - 5 ))")).toContain("⏱ 3m");
  });
});

describe("agy_text_view — the plain text the failure classifier reads", () => {
  const view = (raw: string): string => {
    writeFileSync(join(root, "raw.jsonl"), raw);
    return bash(`agy_text_view "${join(root, "raw.jsonl")}"`).stdout;
  };

  it("keeps agy's own stderr lines and drops every event, including the tool output inside them", () => {
    const out = view(`Error: authentication timed out.\n${lines(init, tool(2, "DONE", "run_command", { CommandLine: "ls" }))}`);
    expect(out).toBe("Error: authentication timed out.\n");
  });

  it("turns a result event's error into an `Error:` line (an error line is what the classifier trusts) and keeps the answer", () => {
    expect(view(lines(init, result("ERROR", { error: "authentication failed or timed out" })))).toBe("Error: authentication failed or timed out\n");
    expect(view(lines(init, result("SUCCESS", { response: "PR opened: https://github.com/o/r/pull/9\n" })))).toBe("PR opened: https://github.com/o/r/pull/9\n");
  });

  it("is empty for an empty file, never an error", () => {
    expect(view("")).toBe("");
  });
});

describe("agy_run — one run, one Telegram message", () => {
  const RUN = (key: string): string => `
WORK="${root}/work"; mkdir -p "$WORK"; printf 'do the task' >"${root}/prompt"
agy_run "Antigravity #44 · owner/app" "$WORK" "${root}/prompt" gemini-3.6-flash-medium 1800 "${root}/text.log" "${key}"
echo "rc=$?"
agy_progress_outcome "📦 PR #9 opened"
`;

  it("sends ONE message, edits it, ends with the outcome appended, and never deletes anything", () => {
    const out = lines(init, tool(2, "DONE", "run_command", { CommandLine: "git status" }), tool(3, "DONE", "run_command", { CommandLine: "npm test" }), result("SUCCESS", { response: "done" }));
    const r = bash(RUN(FAKE_KEY), { AGY_OUT: out, AGY_SLEEP_AFTER: "1" });

    expect(r.stdout).toContain("rc=0");
    const calls = telegram();
    expect(calls.filter((c) => c.kind === "send")).toHaveLength(1);
    expect(calls.filter((c) => c.kind === "delete")).toHaveLength(0);
    const edits = calls.filter((c) => c.kind === "edit");
    expect(edits.length).toBeGreaterThanOrEqual(2);
    expect(new Set(edits.map((c) => c.id))).toEqual(new Set(["7"])); // every edit targets the one message
    const last = edits[edits.length - 1]?.text ?? "";
    expect(last).toMatch(/^✅ Antigravity #44 · owner\/app/);
    expect(last).toContain("✅ run npm test");
    expect(last.trimEnd().endsWith("📦 PR #9 opened")).toBe(true);
  });

  it("returns agy's exit code and leaves the plain-text view for the classifier", () => {
    const r = bash(RUN(""), { AGY_ERR: "Error: authentication timed out.\n", AGY_OUT: lines(init, result("ERROR", { error: "authentication failed or timed out" })), AGY_RC: "1" });

    expect(r.stdout).toContain("rc=1");
    expect(readFileSync(join(root, "text.log"), "utf8")).toContain("Error: authentication timed out.");
    expect(readFileSync(join(root, "text.log"), "utf8")).toContain("Error: authentication failed or timed out");
    // and that view classifies as an auth failure, which is what pauses the loop instead of failing the issue
    const klass = bash(`source "${LIB_DIR}agy-failure.sh"; classify_agy_failure "${root}/text.log"`).stdout.trim();
    expect(klass).toBe("auth");
  });

  it("hands the key over on STDIN: it is in agy's environment and in no sudo argv", () => {
    bash(RUN(FAKE_KEY), { AGY_OUT: lines(init, result("SUCCESS")) });

    expect(readFileSync(join(root, "agy-env.log"), "utf8").trim()).toBe(FAKE_KEY);
    expect(readFileSync(join(root, "sudo-argv.log"), "utf8")).not.toContain(FAKE_KEY);
  });

  it("exports no key at all when there is none (an empty GEMINI_API_KEY is not 'no key' to a CLI)", () => {
    bash(RUN(""), { AGY_OUT: lines(init, result("SUCCESS")) });

    expect(readFileSync(join(root, "agy-env.log"), "utf8").trim()).toBe("<unset>");
  });

  it("passes the workspace, prompt file, model and timeouts as positional arguments, never spliced into the script", () => {
    bash(RUN(""), { AGY_OUT: lines(init, result("SUCCESS")) });

    const sudo = readFileSync(join(root, "sudo-argv.log"), "utf8");
    expect(sudo).toContain("-u tester -- bash -lc");
    expect(sudo).toContain(`${root}/work ${root}/prompt 1800 gemini-3.6-flash-medium 1680s`);
  });

  it("does not stop the run when Telegram is unreachable: no message id, no edits to nowhere", () => {
    stub("curl", "exit 7");
    const r = bash(RUN(""), { AGY_OUT: lines(init, result("SUCCESS")) });

    expect(r.stdout).toContain("rc=0");
    expect(readFileSync(join(root, "daemon.log"), "utf8")).toContain("message FAILED sent");
  });
});
