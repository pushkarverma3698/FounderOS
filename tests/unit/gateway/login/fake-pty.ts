import { vi } from "vitest";
import type { PtyChild } from "../../../../src/gateway/login/pty-child.js";

export const ESC = String.fromCharCode(27);
export const BEL = String.fromCharCode(7);

/** An OSC 8 hyperlink the way the TUIs print their sign-in URL. */
export const osc8 = (url: string, text = "Click here"): string => `${ESC}]8;;${url}${BEL}${text}${ESC}]8;;${BEL}`;

export interface FakePty {
  readonly child: PtyChild;
  readonly writes: string[];
  readonly kill: ReturnType<typeof vi.fn>;
  feed(text: string): void;
}

/**
 * A scripted child: `onWrite` may feed output in response to what the adapter types.
 * waitFor answers from the output already present (no real timers), so tests are instant.
 */
export function fakePty(initial = "", onWrite?: (text: string, feed: (s: string) => void) => void): FakePty {
  let buf = initial;
  let exited = false;
  const writes: string[] = [];
  const kill = vi.fn(() => {
    exited = true;
  });
  const feed = (s: string): void => {
    buf += s;
  };
  const child: PtyChild = {
    raw: () => buf,
    write: (t) => {
      writes.push(t);
      onWrite?.(t, feed);
    },
    waitFor: async (extract) => extract(buf),
    get exited() {
      return exited;
    },
    kill,
  };
  return { child, writes, kill, feed };
}
