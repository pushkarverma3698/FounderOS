/** Small helpers the /login adapters share. */

export const escHtml = (s: string): string => s.replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"));

/** A URL as a Telegram HTML link: `&` must be escaped inside the href. */
export const htmlLink = (url: string, text: string): string =>
  `<a href="${url.replace(/&/g, "&amp;").replace(/"/g, "%22")}">${escHtml(text)}</a>`;

export const todayUtc = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 10);

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What an OAuth code pasted back from a browser looks like: one token, no spaces (`code#state` is allowed). */
export const looksLikeCode = (s: string): boolean => /^[A-Za-z0-9_#.~/+=-]{8,2048}$/.test(s);

/** The environment every login child gets: PATH and a throwaway HOME, nothing the bot holds. */
export function loginEnv(home: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return { PATH: base["PATH"] ?? "/usr/local/bin:/usr/bin:/bin", HOME: home, TERM: "xterm-256color" };
}
