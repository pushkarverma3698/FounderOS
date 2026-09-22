/**
 * FounderOS — boot an app from a checkout so a browser can look at it
 * ====================================================================
 * The I/O half of the app gate. Given a checkout directory and an ./app-recipes
 * entry, run the install and build, start the server, wait until it answers, and
 * hand back an origin plus a `stop()` the caller MUST await.
 *
 * ## Every failure here is returned, never thrown
 *
 * A gate that crashes produces no row, and a run that produced no row is
 * indistinguishable from a run that found nothing wrong — the same
 * did-not-run-reads-as-clean failure `src/evolution/run-audit.ts` and the
 * `render-failed` row in ./ui-analyze.ts both exist to prevent. So `bootApp`
 * resolves with `{ ok: false, stage, detail }` and the caller turns that into a
 * visible blocking row with the captured output attached.
 *
 * ## Process groups, not processes
 *
 * `npm run preview` is a shell wrapper that execs vite in a child. Killing the
 * npm pid leaves vite holding the port, and the NEXT gate on the same box then
 * measures the PREVIOUS pull request's build and reports it as this one's. So
 * every command is spawned `detached` — which gives it its own process group —
 * and stopped with `kill(-pid)`, which signals the whole group. SIGTERM first,
 * SIGKILL after a grace period, because a server that ignores SIGTERM must not
 * be able to wedge the sweep.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolveCommand, type AppRecipe } from "./app-recipes.js";

/** How long the whole install may take. npm ci on a cold cache is genuinely slow. */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;
/** How long the production build may take. */
export const BUILD_TIMEOUT_MS = 10 * 60_000;
/** How long to wait for the started server to answer its ready path. */
export const READY_TIMEOUT_MS = 90_000;
/** Between readiness polls. */
export const READY_POLL_MS = 500;
/** Grace between SIGTERM and SIGKILL when stopping the server group. */
export const KILL_GRACE_MS = 3_000;
/** Bytes of captured output kept per command — enough to diagnose, small enough to post. */
export const OUTPUT_TAIL_CHARS = 4_000;

export type BootStage = "install" | "build" | "start" | "ready";

export interface BootFailure {
  readonly ok: false;
  readonly stage: BootStage;
  readonly detail: string;
  /** Tail of the failing command's combined output. Empty when there was none. */
  readonly output: string;
}

export interface BootSuccess {
  readonly ok: true;
  readonly origin: string;
  /** Tail of the server's own output, read after the run. */
  readonly serverOutput: () => string;
  readonly stop: () => Promise<void>;
}

export type BootResult = BootSuccess | BootFailure;

/** Keeps only the last OUTPUT_TAIL_CHARS so an npm build cannot blow the report up. */
function tail(text: string): string {
  return text.length <= OUTPUT_TAIL_CHARS ? text : `…${text.slice(-OUTPUT_TAIL_CHARS)}`;
}

/** Signal a whole process group, tolerating a group that has already exited. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // allow-failopen: the group is already gone, which is the state we wanted.
  }
}

export interface RunResult {
  readonly code: number | null;
  readonly output: string;
  readonly timedOut: boolean;
}

/** Run one command to completion in `cwd`, capturing combined output. */
export async function runCommand(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
  timeoutMs: number,
): Promise<RunResult> {
  const [command, ...args] = argv;
  return new Promise<RunResult>((resolvePromise) => {
    const child = spawn(command as string, args, {
      cwd,
      env: { ...process.env, ...env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let output = "";
    const capture = (chunk: Buffer): void => {
      output = tail(output + chunk.toString());
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGKILL");
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ code: null, output: tail(`${output}\n${err.message}`), timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, output, timedOut });
    });
  });
}

/**
 * Poll `url` until it answers, or give up.
 *
 * ANY HTTP response counts as ready, including a 404. The readiness question is
 * "is something listening and serving", not "is this route correct" — a 404 from
 * the app is the browser's problem to report as a defect row, with its URL
 * attached, rather than this function's problem to report as "the app never
 * started", which would name the wrong component.
 */
export async function waitForServer(
  url: string,
  timeoutMs: number = READY_TIMEOUT_MS,
  pollMs: number = READY_POLL_MS,
  // Checked every poll. A server process that has already exited is never going
  // to answer, and waiting out the full 90s for it costs the sweep a minute and
  // a half per broken branch for information it had in the first 200ms.
  giveUp: () => boolean = () => false,
  now: () => number = Date.now,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (giveUp()) return false;
    try {
      await fetch(url, { signal: AbortSignal.timeout(5_000) });
      return true;
    } catch {
      // allow-failopen: not up yet is the expected state of this loop.
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return false;
}

/**
 * Install, build, start and wait. The caller owns `stop()`.
 *
 * `skipInstall` exists for the re-run case: a gate that re-checks the same
 * checkout after a push should not pay `npm ci` twice, and node_modules that is
 * already correct is not made more correct by deleting it.
 */
export async function bootApp(
  recipe: AppRecipe,
  checkoutDir: string,
  opts: { port?: number; skipInstall?: boolean } = {},
): Promise<BootResult> {
  const port = opts.port ?? recipe.port;
  const env = { ...(recipe.env ?? {}), PORT: String(port) };
  const origin = `http://127.0.0.1:${port}`;

  if (!opts.skipInstall) {
    const installed = await runCommand(recipe.install, checkoutDir, env, INSTALL_TIMEOUT_MS);
    if (installed.code !== 0) {
      return {
        ok: false,
        stage: "install",
        detail: installed.timedOut
          ? `\`${recipe.install.join(" ")}\` did not finish within ${INSTALL_TIMEOUT_MS / 60_000} minutes.`
          : `\`${recipe.install.join(" ")}\` exited ${installed.code}.`,
        output: installed.output,
      };
    }
  }

  if (recipe.build) {
    const built = await runCommand(recipe.build, checkoutDir, env, BUILD_TIMEOUT_MS);
    if (built.code !== 0) {
      return {
        ok: false,
        stage: "build",
        detail: built.timedOut
          ? `\`${recipe.build.join(" ")}\` did not finish within ${BUILD_TIMEOUT_MS / 60_000} minutes.`
          : `\`${recipe.build.join(" ")}\` exited ${built.code}. The app cannot be looked at because it does not build.`,
        output: built.output,
      };
    }
  }

  const startArgv = resolveCommand(recipe.start, port);
  const [command, ...args] = startArgv;
  const server = spawn(command as string, args, {
    cwd: checkoutDir,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  const capture = (chunk: Buffer): void => {
    serverOutput = tail(serverOutput + chunk.toString());
  };
  server.stdout?.on("data", capture);
  server.stderr?.on("data", capture);

  let exitedEarly: number | null | undefined;
  server.on("close", (code) => {
    exitedEarly = code;
  });
  let spawnError = "";
  server.on("error", (err) => {
    spawnError = err.message;
  });

  const stop = async (): Promise<void> => {
    if (exitedEarly !== undefined) return;
    killGroup(server, "SIGTERM");
    await new Promise((r) => setTimeout(r, KILL_GRACE_MS));
    killGroup(server, "SIGKILL");
  };

  const ready = await waitForServer(
    `${origin}${recipe.readyPath}`,
    READY_TIMEOUT_MS,
    READY_POLL_MS,
    () => exitedEarly !== undefined || spawnError !== "",
  );
  if (!ready) {
    await stop();
    return {
      ok: false,
      stage: exitedEarly !== undefined || spawnError ? "start" : "ready",
      detail:
        exitedEarly !== undefined
          ? `\`${startArgv.join(" ")}\` exited ${exitedEarly} instead of serving ${origin}.`
          : spawnError
            ? `\`${startArgv.join(" ")}\` could not be started: ${spawnError}`
            : `\`${startArgv.join(" ")}\` ran but nothing answered ${origin}${recipe.readyPath} within ` +
              `${READY_TIMEOUT_MS / 1000}s.`,
      output: tail(`${serverOutput}\n${spawnError}`),
    };
  }

  return { ok: true, origin, serverOutput: () => serverOutput, stop };
}
