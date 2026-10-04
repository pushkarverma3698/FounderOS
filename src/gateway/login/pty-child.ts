/**
 * A child process behind a pseudo-terminal, for CLIs that only log in from a TUI
 * (`claude setup-token`, `agy`). No node-pty dependency: util-linux / BSD `script(1)` gives the
 * child a pty, and `stty` inside it fixes the window size (a TUI with a 0x0 window draws nothing).
 *
 * The output buffer holds whatever the CLI printed, which may include a token. It is never logged
 * and never returned: callers pass an `extract` function and get back only what it picks out.
 */

import { spawn } from "node:child_process";

export interface PtyChild {
  /** Everything printed so far (raw, ANSI included, capped). Secrets possible: do not log. */
  raw(): string;
  write(text: string): void;
  /** First non-null `extract(raw)`, or null when `timeoutMs` passes or the child exits first. */
  waitFor<T>(extract: (raw: string) => T | null, timeoutMs: number): Promise<T | null>;
  readonly exited: boolean;
  kill(): void;
}

export type SpawnPty = (argv: readonly string[], env: Record<string, string>) => PtyChild;

const MAX_BUFFER = 512 * 1024;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** Strips terminal escape sequences (colours, cursor moves, hyperlinks) and carriage returns. */
export function stripAnsi(raw: string): string {
  return raw
    .replace(new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g"), "")
    .replace(new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
    .replace(new RegExp(`${ESC}[()][A-Z0-9]|${ESC}[=>]`, "g"), "")
    .replace(/\r/g, "");
}

/** First https URL carried by an OSC 8 hyperlink whose host matches (the TUIs wrap their long sign-in URL across lines). */
export function extractHyperlink(raw: string, hostPattern: RegExp): string | null {
  const re = new RegExp(`${ESC}\\]8;[^;${BEL}${ESC}]*;(https://[^${BEL}${ESC}]+)(?:${BEL}|${ESC}\\\\)`, "g");
  for (const m of raw.matchAll(re)) {
    if (m[1] && hostPattern.test(m[1])) return m[1];
  }
  return null;
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The command that runs `argv` inside a pty (util-linux `script`). Linux only: BSD `script` on macOS calls
 * tcgetattr on its own stdin and fails ("Operation not supported on socket") when node gives it a pipe.
 */
export function ptyCommand(argv: readonly string[]): [string, string[]] {
  const inner = `stty -echo cols 500 rows 50; exec ${argv.map(shq).join(" ")}`;
  return ["script", ["-qfec", inner, "/dev/null"]];
}

export const spawnPty: SpawnPty = (argv, env) => {
  const [cmd, args] = ptyCommand(argv);
  const child = spawn(cmd, args, { env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let buf = "";
  let exited = false;
  const waiters = new Set<() => void>();
  const wake = (): void => waiters.forEach((w) => w());
  const onData = (d: Buffer): void => {
    buf = (buf + d.toString("utf8")).slice(-MAX_BUFFER);
    wake();
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.stdin.on("error", () => undefined); // allow-failopen: writing to a child that already exited is not an error here
  const onEnd = (): void => {
    exited = true;
    wake();
  };
  child.on("error", onEnd);
  child.on("close", onEnd);

  const kill = (): void => {
    if (exited || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL"); // the whole group: script and the CLI under it
    } catch {
      // allow-failopen: the group may already be gone; fall back to the direct child.
      child.kill("SIGKILL");
    }
  };

  return {
    raw: () => buf,
    write: (text) => {
      if (!exited) child.stdin.write(text);
    },
    get exited() {
      return exited;
    },
    kill,
    waitFor: <T>(extract: (raw: string) => T | null, timeoutMs: number): Promise<T | null> =>
      new Promise((resolve) => {
        let timer: NodeJS.Timeout | undefined;
        const check = (): void => {
          const hit = extract(buf);
          if (hit !== null) return done(hit);
          if (exited) done(null);
        };
        const done = (v: T | null): void => {
          waiters.delete(check);
          if (timer) clearTimeout(timer);
          resolve(v);
        };
        timer = setTimeout(() => done(null), timeoutMs);
        waiters.add(check);
        check();
      }),
  };
};
