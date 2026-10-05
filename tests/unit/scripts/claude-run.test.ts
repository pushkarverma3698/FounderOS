/**
 * One Claude Code turn, shown live — deploy/lib/claude-run.sh.
 * ============================================================
 * The Claude executor's counterpart of agy-run.sh: it runs `claude -p` as the antigravity user, shows the run in ONE
 * Telegram message, and leaves a text view for the failure classifier. What differs from agy, and is pinned here:
 *
 *   - the token travels on stdin and arrives as CLAUDE_CODE_OAUTH_TOKEN; an ANTHROPIC_API_KEY in the executor's profile
 *     is removed, so what is billed is what the founder set up;
 *   - Claude Code reports a weekly limit with EXIT 0: only `rate_limit_info.status:"rejected"` and the result's
 *     `is_error` say so, so the text view must turn both into the lines the classifier reads;
 *   - a rate-limit WARNING (`allowed_warning`) is not a failure;
 *   - the reset time is the CLI's `resetsAt`, bounded: a skewed clock must not block claude for ever or for zero seconds.
 *
 * Fixtures and their provenance: claude-streams.ts. The progress view of a working run is built from a synthetic stream:
 * NOT VERIFIED against a live Claude.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { weeklyLimitStream, NOT_LOGGED_IN_STREAM, BAD_TOKEN_STREAM, WORKING_STREAM, WEEKLY_LIMIT_TEXT, NOT_LOGGED_IN_TEXT, BAD_TOKEN_TEXT } from "./claude-streams.js";

const LIB_DIR = fileURLToPath(new URL("../../../deploy/lib/", import.meta.url));
const TOKEN = "sk-ant-" + "oat01-" + "C".repeat(40);

let root: string;
let stubs: string;

function stub(name: string, body: string): void {
  const p = join(stubs, name);
  writeFileSync(p, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
  chmodSync(p, 0o755);
}

function bash(script: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    "bash",
    [
      "-c",
      `log() { printf '%s\\n' "$*" >>"$LOGF"; }
ENV_FILE="$ENVF"; AG_USER=tester; PROGRESS_POLL_SEC=0
source "${LIB_DIR}down-state.sh"; source "${LIB_DIR}agy-failure.sh"; source "${LIB_DIR}agy-run.sh"; source "${LIB_DIR}claude-run.sh"
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
        CLAUDE_ENV_LOG: join(root, "claude-env.log"),
        TG_QUIET_NOW: "12", // daytime: notify must not depend on when CI runs
        ...env,
      },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const rawFile = (): string => join(root, "raw.jsonl");
const textView = (raw: string): string => {
  writeFileSync(rawFile(), raw.endsWith("\n") ? raw : `${raw}\n`);
  return bash(`claude_text_view "${rawFile()}"`).stdout;
};
const render = (raw: string): string => {
  writeFileSync(rawFile(), `${raw}\n`);
  return bash(`claude_progress_render "${rawFile()}" "Claude Code #44 · owner/app" sonnet "$(( $(date +%s) - 125 ))"`).stdout.replace(/\n$/, "");
};
const tokenFile = (): string => join(root, ".claude", "claude-code.token");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "claude-run-"));
  stubs = join(root, "stubs");
  mkdirSync(stubs, { recursive: true });
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".env"), "TELEGRAM_BOT_TOKEN=987654321:" + "T".repeat(35) + "\nTELEGRAM_CHAT_ID=1\n");
  stub("sudo", `printf '%s\\n' "$*" >>"$SUDO_ARGV"\nwhile [ "$1" != "--" ]; do shift; done; shift; exec "$@"`);
  stub("timeout", `shift; exec "$@"`);
  stub(
    "curl",
    `kind=""; text=""
for a in "$@"; do case "$a" in */sendMessage) kind=send ;; */editMessageText) kind=edit ;; text=*) text="\${a#text=}" ;; esac; done
printf '%s\\t%s\\n@@\\n' "$kind" "$text" >>"$SENDS"
printf '{"ok":true,"result":{"message_id":7}}\\n'`,
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("claude_text_view — what the failure classifier reads", () => {
  it("a weekly limit [shape]: the rejection and the result's error, how the run ENDED last", () => {
    const view = textView(weeklyLimitStream(1791180000)).trimEnd().split("\n");

    expect(view).toContain("Error: usage limit reached · resetsAt=1791180000");
    expect(view[view.length - 1]).toBe(`Error: ${WEEKLY_LIMIT_TEXT}`);
  });

  it("not logged in [captured]", () => {
    expect(textView(NOT_LOGGED_IN_STREAM).trimEnd()).toBe(`Error: ${NOT_LOGGED_IN_TEXT}`);
  });

  it("a rejected token [captured]: the 401 retries are noise, the result is the line", () => {
    const view = textView(BAD_TOKEN_STREAM).trimEnd();
    expect(view).toBe(`Error: ${BAD_TOKEN_TEXT}`);
  });

  it("a working run [synthetic]: the final answer, no error, and a limit WARNING is not one", () => {
    const view = textView(WORKING_STREAM);
    expect(view.trimEnd()).toBe("Opened the draft PR.");
    expect(view).not.toMatch(/Error:/);
  });

  it("narration and tool output stay out of it: an agent discussing a 401 must not read as one [synthetic]", () => {
    const talk = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Error: 401 Unauthorized is what the API returns" }] } });
    const toolOut = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "Error: not logged in" }] } });
    const view = textView(`${talk}\n${toolOut}\n${JSON.stringify({ type: "result", is_error: false, result: "done" })}`);
    expect(view.trimEnd()).toBe("done");
  });

  it("lines that are not events (the CLI's own stderr, `timeout`'s) are kept, in front of how the run ended [synthetic]", () => {
    const view = textView(`claude: error while loading shared libraries\n${NOT_LOGGED_IN_STREAM}`).trimEnd().split("\n");
    expect(view[0]).toBe("claude: error while loading shared libraries");
    expect(view[view.length - 1]).toBe(`Error: ${NOT_LOGGED_IN_TEXT}`);
  });

  it("a run that ended in an error subtype with no message still ends in an Error: line [synthetic]", () => {
    const view = textView(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true }));
    expect(view).toMatch(/^Error: .*error_during_execution/m);
  });

  it("an empty or missing stream is an empty view, never a crash", () => {
    expect(textView("").trim()).toBe("");
    const missing = bash(`claude_text_view "${join(root, "nope.jsonl")}"`);
    expect(missing.status).toBe(0);
    expect(missing.stdout).toBe("");
  });
});

describe("claude's text view classifies as the right failure", () => {
  const classify = (raw: string): string => {
    writeFileSync(rawFile(), `${raw}\n`);
    return bash(`claude_text_view "${rawFile()}" >"${join(root, "t.log")}"; classify_agy_failure "${join(root, "t.log")}"`).stdout.trim();
  };

  it("the weekly limit is quota [shape]", () => expect(classify(weeklyLimitStream(1791180000))).toBe("quota"));
  it("not logged in is auth [captured]", () => expect(classify(NOT_LOGGED_IN_STREAM)).toBe("auth"));
  it("a rejected token is auth [captured]", () => expect(classify(BAD_TOKEN_STREAM)).toBe("auth"));
  it("a working run is unknown (nothing to classify)", () => expect(classify(WORKING_STREAM)).toBe("unknown"));
});

describe("claude_quota_epoch — when claude's limit lifts", () => {
  const now = (): number => Math.floor(Date.now() / 1000);
  const epochFor = (raw: string): { status: number | null; epoch: number } => {
    writeFileSync(rawFile(), `${raw}\n`);
    const r = bash(`claude_text_view "${rawFile()}" >"${join(root, "t.log")}"; claude_quota_epoch "${join(root, "t.log")}"`);
    return { status: r.status, epoch: Number(r.stdout.trim()) };
  };

  it("is the resetsAt the CLI reported", () => {
    const at = now() + 3 * 86400;
    expect(epochFor(weeklyLimitStream(at))).toEqual({ status: 0, epoch: at });
  });

  it("is an hour from now when the CLI gave none", () => {
    const noReset = JSON.stringify({ type: "result", is_error: true, result: "You've hit your weekly limit", api_error_status: 429 });
    const r = epochFor(noReset);
    expect(r.status).toBe(0);
    expect(Math.abs(r.epoch - (now() + 3600))).toBeLessThan(60);
  });

  it("is an hour from now when resetsAt is already past: a skewed clock must not mean 'run it now, hit the wall again'", () => {
    const r = epochFor(weeklyLimitStream(now() - 600));
    expect(Math.abs(r.epoch - (now() + 3600))).toBeLessThan(60);
  });

  it("is capped at 8 days: a nonsense far-future reset must not block claude for good", () => {
    const r = epochFor(weeklyLimitStream(now() + 400 * 86400));
    expect(Math.abs(r.epoch - (now() + 8 * 86400))).toBeLessThan(60);
  });

  it("fails for anything that is not a quota wall", () => {
    expect(epochFor(NOT_LOGGED_IN_STREAM).status).not.toBe(0);
    expect(epochFor(WORKING_STREAM).status).not.toBe(0);
  });
});

describe("claude_token — line 1 of the founder's token file", () => {
  it("prints it, trimmed", () => {
    writeFileSync(tokenFile(), `  ${TOKEN} \r\nignored second line\n`);
    expect(bash(`claude_token`).stdout).toBe(`${TOKEN}\n`);
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["blank lines", "\n\n  \n"],
  ] as const)("fails, printing nothing, when the file is %s", (_what, content) => {
    if (content !== null) writeFileSync(tokenFile(), content);
    const r = bash(`claude_token`);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });

  it("the path is configurable", () => {
    const other = join(root, "elsewhere.token");
    writeFileSync(other, `${TOKEN}\n`);
    expect(bash(`claude_token`, { AGENT_DISPATCH_CLAUDE_TOKEN_FILE: other }).stdout).toBe(`${TOKEN}\n`);
  });
});

describe("claude_progress_render — the live Telegram text [synthetic stream: NOT VERIFIED live]", () => {
  it("shows the last tool calls, finished ones ticked, and the working path without the workspace prefix", () => {
    const text = render(WORKING_STREAM);
    expect(text.split("\n")[0]).toBe("✅ Claude Code #44 · owner/app");
    expect(text).toMatch(/⏱ 2m · sonnet · 2 tool calls/);
    expect(text).toContain("✅ run pnpm test --run");
    expect(text).toContain("⏳ read src/a.ts");
    expect(text).not.toContain("/opt/agy-workspace");
  });

  it("a run still going has the wrench; one that ended in an error has the warning sign", () => {
    expect(render(WORKING_STREAM.split("\n").slice(0, 3).join("\n")).split("\n")[0]).toBe("🔧 Claude Code #44 · owner/app");
    expect(render(BAD_TOKEN_STREAM).split("\n")[0]).toBe("⚠️ Claude Code #44 · owner/app");
  });

  it("survives a half-written last line, and an empty stream renders just its header", () => {
    expect(render(`${WORKING_STREAM.split("\n").slice(0, 3).join("\n")}\n{"type":"assis`)).toContain("run pnpm test --run");
    expect(render("").split("\n")[0]).toBe("🔧 Claude Code #44 · owner/app");
  });

  it("a secret in a command never reaches Telegram", () => {
    const leak = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: `curl -H "Authorization: ${TOKEN}" x` } }] } });
    writeFileSync(join(root, "lit.sh"), "");
    const out = bash(`REDACT_LITERALS+=("${TOKEN}"); printf '%s\\n' '${leak}' >"${rawFile()}"; claude_progress_render "${rawFile()}" L sonnet 0`).stdout;
    expect(out).not.toContain(TOKEN);
  });
});

describe("claude_run", () => {
  const run = (env: Record<string, string> = {}, claudeBody = `printf '%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN-<unset>}|\${ANTHROPIC_API_KEY-<unset>}" >>"$CLAUDE_ENV_LOG"; printf '%s\\n' "$*" >"${join(root, "argv")}"; cat "${join(root, "stream")}"; exit "\${CLAUDE_RC:-0}"`) => {
    stub("claude", claudeBody);
    writeFileSync(join(root, "prompt.txt"), "do the task");
    return bash(`claude_run "Claude Code #1" "${root}" "${join(root, "prompt.txt")}" sonnet 600 "${join(root, "text.log")}" "${TOKEN}"; echo "rc=$?"`, env);
  };

  it("hands the token over in claude's environment only, and removes an API key from the executor's profile", () => {
    writeFileSync(join(root, "stream"), WORKING_STREAM);

    const r = run({ ANTHROPIC_API_KEY: "sk-ant-api03-" + "k".repeat(40) });

    expect(r.stdout).toContain("rc=0");
    expect(readFileSync(join(root, "claude-env.log"), "utf8")).toBe(`${TOKEN}|<unset>\n`);
    expect(readFileSync(join(root, "argv"), "utf8")).not.toContain(TOKEN);
    expect(readFileSync(join(root, "sudo-argv.log"), "utf8")).not.toContain(TOKEN);
  });

  it("runs `claude -p <prompt>` with the model, the permission flag and the stream format", () => {
    writeFileSync(join(root, "stream"), WORKING_STREAM);
    run();
    expect(readFileSync(join(root, "argv"), "utf8").trim()).toBe(
      "-p do the task --model sonnet --dangerously-skip-permissions --output-format stream-json --verbose",
    );
  });

  it("returns claude's exit code, leaves the text view, and shows one message that it edited", () => {
    writeFileSync(join(root, "stream"), BAD_TOKEN_STREAM);

    const r = run({ CLAUDE_RC: "1" });

    expect(r.stdout).toContain("rc=1");
    expect(readFileSync(join(root, "text.log"), "utf8").trimEnd()).toBe(`Error: ${BAD_TOKEN_TEXT}`);
    const sends = readFileSync(join(root, "telegram.log"), "utf8");
    expect((sends.match(/^send\t/gm) ?? []).length).toBe(1);
    expect(sends).toMatch(/^edit\t⚠️ Claude Code #1/m);
  });

  it("no token given: claude gets none, rather than an empty one that would read as 'logged in with nothing'", () => {
    writeFileSync(join(root, "stream"), WORKING_STREAM);
    stub("claude", `printf '%s\\n' "\${CLAUDE_CODE_OAUTH_TOKEN-<unset>}" >"${join(root, "seen")}"; cat "${join(root, "stream")}"`);
    writeFileSync(join(root, "prompt.txt"), "x");

    bash(`claude_run L "${root}" "${join(root, "prompt.txt")}" sonnet 600 "${join(root, "text.log")}"`);

    expect(existsSync(join(root, "seen"))).toBe(true);
    expect(readFileSync(join(root, "seen"), "utf8").trim()).toBe("<unset>");
  });
});
