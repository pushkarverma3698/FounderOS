#!/usr/bin/env node
/**
 * telegram-verify.mjs — SubagentStop hook (FounderOS dev-harness)
 * ================================================================
 * Intercepts a department subagent's stop, extracts its final message and the
 * test-execution log it tee'd to .claude/run/subagent-test-log.txt, and pushes
 * both through the Telegram bridge (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID from
 * process.env or the project .env) so the founder sees evidence before the
 * task counts as complete.
 *
 * Delivery contract:
 *   - 3 attempts with backoff → success appended to .claude/run/telegram-verify.log
 *   - after 3 failures → detail + HALT_AFTER_3_FAILURES marker appended to
 *     .claude/run/telegram-failures.log; the orchestrator must halt and
 *     surface that log to the founder.
 *   - always exits 0 — a broken Telegram bridge must surface via logs,
 *     never by wedging the agent session.
 *     // allow-failopen: hook must never block or loop agent sessions
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_RESULT_CHARS = 2500;
const MAX_TEST_LOG_CHARS = 1000;
const MAX_MESSAGE_CHARS = 4000;
const MAX_ATTEMPTS = 3;
const SEND_TIMEOUT_MS = 10_000;
const TEST_LOG_MAX_AGE_MS = 30 * 60 * 1000;

function readStdinJson() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const entries = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim()))
    .filter(Boolean)
    .map((m) => [m[1], m[2].replace(/^["']|["']$/g, "")]);
  return Object.fromEntries(entries);
}

/** Last assistant text block in a Claude Code transcript (JSONL, newest last). */
function lastAssistantText(transcriptPath) {
  try {
    const lines = readFileSync(transcriptPath, "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        const content = entry?.message?.content;
        if (entry?.type === "assistant" && Array.isArray(content)) {
          const text = content
            .filter((block) => block.type === "text" && typeof block.text === "string")
            .map((block) => block.text)
            .join("\n")
            .trim();
          if (text) return text;
        }
      } catch {
        // skip malformed transcript line
      }
    }
  } catch {
    // transcript unreadable — reported below
  }
  return "(final output unavailable — transcript not readable)";
}

function freshTestLog(runDir) {
  const path = join(runDir, "subagent-test-log.txt");
  if (existsSync(path) && Date.now() - statSync(path).mtimeMs < TEST_LOG_MAX_AGE_MS) {
    return readFileSync(path, "utf8").slice(-MAX_TEST_LOG_CHARS);
  }
  return "(no fresh test log — subagent skipped its verification contract)";
}

async function sendWithRetries(token, chatId, text, logPaths, meta) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: controller.signal,
      });
      const body = await res.json();
      if (res.ok && body.ok) {
        appendFileSync(
          logPaths.success,
          `${new Date().toISOString()} SUCCESS message_id=${body.result.message_id} agent=${meta.agent} session=${meta.session} attempt=${attempt}\n`,
        );
        return true;
      }
      appendFileSync(
        logPaths.failure,
        `${new Date().toISOString()} ATTEMPT_${attempt}_FAILED agent=${meta.agent} status=${res.status} body=${JSON.stringify(body).slice(0, 300)}\n`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      appendFileSync(
        logPaths.failure,
        `${new Date().toISOString()} ATTEMPT_${attempt}_FAILED agent=${meta.agent} error=${reason.slice(0, 300)}\n`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  appendFileSync(
    logPaths.failure,
    `${new Date().toISOString()} HALT_AFTER_3_FAILURES agent=${meta.agent} session=${meta.session} — orchestrator must halt and surface this log to the founder\n`,
  );
  return false;
}

async function main() {
  const input = readStdinJson();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const runDir = join(projectDir, ".claude", "run");
  mkdirSync(runDir, { recursive: true });
  const logPaths = {
    success: join(runDir, "telegram-verify.log"),
    failure: join(runDir, "telegram-failures.log"),
  };

  const fileEnv = parseEnvFile(join(projectDir, ".env"));
  const token = process.env.TELEGRAM_BOT_TOKEN || fileEnv.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID || fileEnv.TELEGRAM_CHAT_ID;

  const meta = {
    agent: input.agent_name || input.agent_type || "subagent",
    session: String(input.session_id || "unknown").slice(0, 8),
  };

  if (!token || !chatId) {
    appendFileSync(
      logPaths.failure,
      `${new Date().toISOString()} NO_CREDENTIALS agent=${meta.agent} — TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing\n`,
    );
    return;
  }

  const transcriptPath = input.agent_transcript_path || input.transcript_path;
  const result = transcriptPath
    ? lastAssistantText(transcriptPath)
    : "(no transcript path in hook input)";

  const text = [
    "🤖 FounderOS · dev-agent verification",
    `Agent: ${meta.agent} | session ${meta.session} | ${new Date().toISOString()}`,
    "────────────────────",
    result.slice(0, MAX_RESULT_CHARS),
    "────────────────────",
    "TEST LOG (tail):",
    freshTestLog(runDir),
  ]
    .join("\n")
    .slice(0, MAX_MESSAGE_CHARS);

  await sendWithRetries(token, chatId, text, logPaths, meta);
}

await main();
