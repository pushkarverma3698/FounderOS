/**
 * FounderOS — Turicks Brain (vector RAG) service supervisor
 * ==========================================================
 * The Turicks Brain is the single semantic-retrieval store for the office (a
 * ChromaDB knowledge base served over HTTP by the `turicks-brain-rag` FastAPI
 * app on :8766). It holds decisions, docs, and conversation transcripts — far
 * richer than any keyword index.
 *
 * Problem this solves: when that service is down, every knowledge lookup
 * (`search_knowledge` / `search_turicks_brain`) returns "unavailable" and the
 * office is effectively amnesiac. We don't want to depend on the founder
 * remembering to start it. So on boot we health-check the API and, if it's
 * down, launch it (detached, from its own venv) and poll until it's ready.
 *
 * Reliability contract: this NEVER throws and NEVER blocks the bot. RAG being
 * unavailable degrades answers; it must not stop the office from running. All
 * failures are logged and swallowed.
 */

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { childLogger } from "./logger.js";

const log = childLogger({ module: "rag-service" });

/** Base URL of the Turicks Brain API (kept in sync with src/tools/rag.ts). */
export const TURICKS_BRAIN_URL =
  process.env["TURICKS_BRAIN_URL"] ?? "http://localhost:8766";

/** Project dir of the turicks-brain-rag FastAPI app (env-overridable). */
export const TURICKS_BRAIN_DIR =
  process.env["TURICKS_BRAIN_DIR"] ?? join(homedir(), "Projects", "turicks-brain-rag");

/** Log file the detached uvicorn process writes to. */
const RAG_LOG_FILE = process.env["TURICKS_BRAIN_LOG"] ?? "/tmp/turicks-brain-api.log";

export interface EnsureRagOptions {
  /** Total time to wait for the service to become healthy after launch. */
  readinessTimeoutMs?: number;
  /** Poll interval while waiting for readiness. */
  pollMs?: number;
  /** Test seams. */
  _isHealthy?: () => Promise<boolean>;
  _launch?: () => void;
  _sleep?: (ms: number) => Promise<void>;
}

/** Probe the Turicks Brain API /health endpoint. Returns true only on 200 ok. */
export async function isRagHealthy(timeoutMs = 2500): Promise<boolean> {
  try {
    const resp = await fetch(`${TURICKS_BRAIN_URL}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!resp.ok) return false;
    const body = (await resp.json()) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

/**
 * Launch the FastAPI app detached from this process, using the project's own
 * virtualenv so the bot has no Python dependency of its own. stdout/stderr go to
 * a log file; the child is unref'd so it outlives a bot restart.
 */
function launchRagService(): void {
  const uvicorn = join(TURICKS_BRAIN_DIR, ".venv", "bin", "uvicorn");
  const port = new URL(TURICKS_BRAIN_URL).port || "8766";
  const out = openSync(RAG_LOG_FILE, "a");
  const child = spawn(uvicorn, ["src.api:app", "--port", port], {
    cwd: TURICKS_BRAIN_DIR,
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  log.info({ dir: TURICKS_BRAIN_DIR, port, logFile: RAG_LOG_FILE }, "Launched Turicks Brain API");
}

/**
 * Ensure the Turicks Brain API is up. If already healthy, no-op. Otherwise
 * launch it and poll until healthy or the timeout elapses.
 *
 * @returns true if the service is healthy by the time we return.
 */
export async function ensureRagService(opts: EnsureRagOptions = {}): Promise<boolean> {
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 750;
  const isHealthy = opts._isHealthy ?? (() => isRagHealthy());
  const launch = opts._launch ?? launchRagService;
  const sleep = opts._sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (await isHealthy()) {
    log.info("Turicks Brain API already running");
    return true;
  }

  log.warn("Turicks Brain API down — launching it so knowledge search works");
  try {
    launch();
  } catch (err) {
    log.error({ err: (err as Error).message }, "Failed to launch Turicks Brain API — knowledge search will be degraded");
    return false;
  }

  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    if (await isHealthy()) {
      log.info("Turicks Brain API is ready");
      return true;
    }
  }

  log.error("Turicks Brain API did not become healthy in time — knowledge search will be degraded until it recovers");
  return false;
}
