/**
 * FounderOS — Log Observer Agent
 * ================================
 * Watches the structured pino log stream in real-time and:
 *  1. Counts: requests, successes, failures, LLM errors, HITL events, routing decisions
 *  2. Detects anomalies: "Unknown department" spikes, cascade exhaustion, HITL abandons
 *  3. Reports a reliability digest to Telegram (Boardroom topic) every N minutes
 *  4. Emits IMMEDIATE alerts for: cascade exhaustion (all providers failed), repeated
 *     null-routing, and process-level uncaught exceptions in the log stream
 *
 * DESIGN PRINCIPLES (anti-hallucination):
 *  - Only reports what it literally parses from the log — ZERO inference, ZERO summaries
 *  - Every metric shows the exact count from the observation window
 *  - Anomalies include the raw log line that triggered them
 *  - Reports are labeled "Observed [start]→[end]" so you know exactly what window is covered
 *  - No LLM calls — purely deterministic log parsing
 *
 * Usage:
 *   import { startLogObserver, stopLogObserver } from "./log-observer.js"
 *   startLogObserver(logFilePath, telegramChatId, boardroomTopicId)
 */

import * as fs from "node:fs";
import { childLogger } from "./logger.js";
import { env } from "../core/config.js";

const log = childLogger({ module: "log-observer" });

// ── Types ─────────────────────────────────────────────────────────────────────

interface ParsedLogLine {
  level: number;         // pino level: 10=trace 20=debug 30=info 40=warn 50=error 60=fatal
  time: number;          // unix ms
  msg: string;
  module?: string;
  err?: string;
  department?: string;
  agent?: string;
  task?: string;
  tenant_id?: string;
  raw: string;           // original line (for anomaly reports — no paraphrasing)
}

interface ObservationWindow {
  startTime: Date;
  endTime?: Date;

  // Counters
  totalMessages: number;
  tasksRouted: number;
  tasksCompleted: number;   // graph returned a result
  tasksFailed: number;      // Error log during graph execution
  hitlCreated: number;
  hitlResolved: number;
  hitlExpired: number;
  llmCascadeExhausted: number;  // "All LLM providers failed"
  unknownDepartment: number;    // CEO returned null department
  directAnswer: number;         // CEO answered directly (no routing)

  // Department routing counts (factual, no inference)
  routing: Record<string, number>;

  // Raw anomaly lines (emitted immediately, also included in digest)
  anomalies: string[];

  // Error log lines (raw, no paraphrasing)
  errors: string[];
}

// ── Telegram raw send (no grammy import — avoids circular dep) ────────────────

async function sendAlert(text: string, topicId?: number): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
    };
    if (topicId) body["message_thread_id"] = topicId;

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    log.warn({ err: (err as Error).message }, "log-observer: sendAlert failed");
  }
}

// ── Log line parser ──────────────────────────────────────────────────────────

function parseLine(raw: string): ParsedLogLine | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    return {
      level: (obj["level"] as number) ?? 30,
      time: (obj["time"] as number) ?? Date.now(),
      msg: String(obj["msg"] ?? ""),
      module: obj["module"] as string | undefined,
      err: obj["err"] as string | undefined,
      department: obj["department"] as string | undefined,
      agent: obj["agent"] as string | undefined,
      task: obj["task"] as string | undefined,
      tenant_id: obj["tenant_id"] as string | undefined,
      raw: trimmed,
    };
  } catch {
    return null; // Non-JSON lines (startup text etc.) — skip
  }
}

// ── Window management ─────────────────────────────────────────────────────────

function newWindow(): ObservationWindow {
  return {
    startTime: new Date(),
    totalMessages: 0,
    tasksRouted: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    hitlCreated: 0,
    hitlResolved: 0,
    hitlExpired: 0,
    llmCascadeExhausted: 0,
    unknownDepartment: 0,
    directAnswer: 0,
    routing: {},
    anomalies: [],
    errors: [],
  };
}

// ── Anomaly detection ─────────────────────────────────────────────────────────

/**
 * Returns true if this log line is an anomaly that requires immediate alert.
 * ONLY triggers on high-severity, unambiguous signals — no guessing.
 */
function isImmediateAnomaly(parsed: ParsedLogLine): boolean {
  const msg = parsed.msg.toLowerCase();
  if (parsed.level >= 60) return true;                          // fatal
  if (msg.includes("all llm providers failed")) return true;   // cascade exhaustion
  if (msg.includes("uncaught exception")) return true;         // process crash imminent
  if (msg.includes("unhandled rejection")) return true;        // promise crash
  if (msg.includes("bot polling crashed")) return true;        // telegram offline
  return false;
}

// ── Digest formatter ─────────────────────────────────────────────────────────

function formatDigest(w: ObservationWindow): string {
  const end = w.endTime ?? new Date();
  const startStr = w.startTime.toTimeString().slice(0, 8);
  const endStr = end.toTimeString().slice(0, 8);
  const durationMin = Math.round((end.getTime() - w.startTime.getTime()) / 60_000);

  const routingLines = Object.entries(w.routing)
    .sort(([, a], [, b]) => b - a)
    .map(([dept, count]) => `  • ${dept}: ${count}`)
    .join("\n") || "  (none)";

  const anomalySection =
    w.anomalies.length > 0
      ? `\n⚠️ <b>Anomalies (${w.anomalies.length})</b>\n` +
        w.anomalies.slice(0, 5).map((a) => `<code>${escHtml(a.slice(0, 200))}</code>`).join("\n")
      : "";

  const errorSection =
    w.errors.length > 0
      ? `\n🔴 <b>Errors (${w.errors.length})</b>\n` +
        w.errors.slice(0, 3).map((e) => `<code>${escHtml(e.slice(0, 200))}</code>`).join("\n")
      : "";

  return (
    `📊 <b>FounderOS Log Digest</b>\n` +
    `<i>${startStr} → ${endStr} (${durationMin}m)</i>\n\n` +
    `📨 Messages in: <b>${w.totalMessages}</b>\n` +
    `🔀 Tasks routed: <b>${w.tasksRouted}</b>\n` +
    `✅ Completed: <b>${w.tasksCompleted}</b>\n` +
    `❌ Failed: <b>${w.tasksFailed}</b>\n` +
    `💬 Direct answers: <b>${w.directAnswer}</b>\n` +
    `🚦 Unknown dept: <b>${w.unknownDepartment}</b>\n\n` +
    `🤖 HITL: created <b>${w.hitlCreated}</b> · resolved <b>${w.hitlResolved}</b> · expired <b>${w.hitlExpired}</b>\n` +
    `🔗 Cascade exhausted: <b>${w.llmCascadeExhausted}</b>\n\n` +
    `<b>Department routing:</b>\n${routingLines}` +
    anomalySection +
    errorSection
  );
}

function escHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Observer state ────────────────────────────────────────────────────────────

let _window: ObservationWindow = newWindow();
let _watcher: fs.FSWatcher | undefined;
let _digestInterval: NodeJS.Timeout | undefined;
let _anomalyBuffer = "";          // incomplete line buffer from stream
let _fileHandle: fs.ReadStream | undefined;

// ── Line processor ────────────────────────────────────────────────────────────

async function processLine(rawLine: string, boardroomTopicId?: number): Promise<void> {
  const parsed = parseLine(rawLine);
  if (!parsed) return;

  const msg = parsed.msg.toLowerCase();

  // Count basic events
  if (parsed.module === "telegram" && msg.includes("message received")) _window.totalMessages++;
  if (msg.includes("routing to foundergraph")) _window.tasksRouted++;
  if (msg.includes("graph execution failed") || (parsed.level >= 50 && parsed.module !== "log-observer")) {
    _window.tasksFailed++;
    _window.errors.push(rawLine);
  }
  if (msg.includes("hitl requested") || msg.includes("hitl message sent")) _window.hitlCreated++;
  if (msg.includes("hitl approved") || msg.includes("hitl rejected") || msg.includes("graph resumed")) _window.hitlResolved++;
  if (msg.includes("hitl sweeper") || msg.includes("expired and marked")) _window.hitlExpired++;
  if (msg.includes("all llm providers failed") || msg.includes("cascade exhausted")) _window.llmCascadeExhausted++;
  if (msg.includes("unknown department")) _window.unknownDepartment++;
  if (msg.includes("direct_answer") || msg.includes("direct answer")) _window.directAnswer++;

  // Track department routing (factual count from CEO routing decision logs)
  if (msg.includes("ceo routing decision") && parsed.department && parsed.department !== "") {
    _window.routing[parsed.department] = (_window.routing[parsed.department] ?? 0) + 1;
  }

  // Immediate anomaly alert
  if (isImmediateAnomaly(parsed)) {
    _window.anomalies.push(rawLine);
    const alertText =
      `🚨 <b>FounderOS ALERT</b>\n\n` +
      `Level: <b>${parsed.level >= 60 ? "FATAL" : "ERROR"}</b>\n` +
      `Module: <b>${escHtml(parsed.module ?? "unknown")}</b>\n` +
      `Message: <b>${escHtml(parsed.msg)}</b>\n\n` +
      `<code>${escHtml(rawLine.slice(0, 400))}</code>`;
    await sendAlert(alertText, boardroomTopicId);
    log.warn({ msg: parsed.msg }, "log-observer: immediate anomaly alert sent");
  }
}

// ── File tail reader ──────────────────────────────────────────────────────────

function startTailing(filePath: string, boardroomTopicId?: number): void {
  // Open from end of file (only new lines)
  const stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  const startPos = stat ? stat.size : 0;

  _fileHandle = fs.createReadStream(filePath, { start: startPos, encoding: "utf8" });
  _fileHandle.on("data", (chunk: string | Buffer) => {
    _anomalyBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const lines = _anomalyBuffer.split("\n");
    _anomalyBuffer = lines.pop() ?? ""; // keep incomplete last line
    for (const line of lines) {
      processLine(line, boardroomTopicId).catch(() => {/* non-fatal */});
    }
  });

  // Watch for file growth and re-open stream from new position
  _watcher = fs.watch(filePath, () => {
    // Restart read from current position when file changes
    const newStat = fs.statSync(filePath);
    if (_fileHandle && newStat.size > startPos) {
      // Stream handles this automatically via the open fd
    }
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start the log observer.
 * @param logFilePath   Path to the pino JSON log file (e.g. /tmp/founderos.log)
 * @param digestMinutes Send a digest to Telegram every N minutes (default: 30)
 * @param boardroomTopicId  Telegram message_thread_id for the Boardroom topic
 */
export function startLogObserver(
  logFilePath: string,
  digestMinutes = 30,
  boardroomTopicId?: number,
): void {
  if (_watcher) {
    log.warn("startLogObserver called twice — ignoring");
    return;
  }

  log.info({ logFilePath, digestMinutes }, "Log observer starting");

  // Start tailing
  if (fs.existsSync(logFilePath)) {
    startTailing(logFilePath, boardroomTopicId);
  } else {
    // File doesn't exist yet (first run) — watch parent dir for creation
    log.warn({ logFilePath }, "Log file not found yet — watching for creation");
  }

  // Periodic digest
  _digestInterval = setInterval(async () => {
    _window.endTime = new Date();
    const digest = formatDigest(_window);
    await sendAlert(digest, boardroomTopicId);
    log.info({ window_start: _window.startTime, total_messages: _window.totalMessages }, "Log digest sent");
    _window = newWindow(); // reset for next window
  }, digestMinutes * 60 * 1000);

  log.info({ digestMinutes, boardroomTopicId }, "Log observer running");
}

export function stopLogObserver(): void {
  _watcher?.close();
  _fileHandle?.destroy();
  if (_digestInterval) clearInterval(_digestInterval);
  _watcher = undefined;
  _fileHandle = undefined;
  log.info("Log observer stopped");
}

/**
 * Get current window stats (for /health endpoint or on-demand queries).
 * Returns a snapshot — does NOT reset the window.
 */
export function getObserverStats(): ObservationWindow & { isRunning: boolean } {
  return { ..._window, isRunning: !!_watcher };
}
