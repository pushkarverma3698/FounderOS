/** Pure verdict for golden journey B (30-day plan): do the numbers in /where match GitHub? */
export interface WhereCounts {
  done: number;
  openPrs: number;
  left: number;
}

export interface WhereVerdict {
  ok: boolean;
  detail: string;
}

const FIELDS: readonly (keyof WhereCounts)[] = ["done", "openPrs", "left"];

export function parseWhereReply(text: string): WhereCounts | undefined {
  const done = /Done \(7d\): (\d+)/.exec(text)?.[1];
  const openPrs = /In flight: (\d+) open PRs/.exec(text)?.[1];
  const left = /Left: (\d+) open issues/.exec(text)?.[1];
  if (done === undefined || openPrs === undefined || left === undefined) return undefined;
  return { done: Number(done), openPrs: Number(openPrs), left: Number(left) };
}

/** GitHub is read before and after the bot answers; a reply between the two reads is correct. */
export function judgeWhere(reply: WhereCounts | undefined, before: WhereCounts, after: WhereCounts): WhereVerdict {
  if (!reply) return { ok: false, detail: "reply had no Done / In flight / Left lines" };
  const bad = FIELDS.filter((f) => reply[f] < Math.min(before[f], after[f]) || reply[f] > Math.max(before[f], after[f])).map(
    (f) => `${f}: bot says ${reply[f]}, GitHub says ${before[f]}${before[f] === after[f] ? "" : `–${after[f]}`}`,
  );
  return bad.length > 0
    ? { ok: false, detail: bad.join("; ") }
    : { ok: true, detail: `done ${reply.done}, open PRs ${reply.openPrs}, left ${reply.left} all match GitHub` };
}
