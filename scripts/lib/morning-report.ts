/**
 * The one morning message (AG-051): the score, one line per red journey with its reason, then the health line.
 * Pure. A report longer than one Telegram message is split on line boundaries, never cut (#26).
 */

export type JourneyId = "J1" | "J2" | "J3" | "J4" | "J5" | "A" | "B" | "C";

export interface JourneyResult {
  id: JourneyId;
  status: "green" | "red" | "not_built";
  detail: string;
}

/** Telegram's limit is 4096; leave room for the "(1/2)" marker. */
export const TELEGRAM_CHUNK_CHARS = 3_900;

export const JOURNEY_LABEL: Record<JourneyId, string> = {
  J1: "J1 work inbox",
  J2: "J2 calendar",
  J3: "J3 open PRs",
  J4: "J4 issue + agent",
  J5: "J5 reminder",
  A: "A coding",
  B: "B /where",
  C: "C jobs group",
};

const DAILY: readonly JourneyId[] = ["J1", "J2", "J3", "J4", "J5"];
const NIGHTLY: readonly JourneyId[] = ["A", "B", "C"];

function line(r: JourneyResult): string {
  const icon = r.status === "green" ? "🟢" : r.status === "red" ? "🔴" : "⚪";
  const what = r.status === "not_built" ? `not built (${r.detail})` : r.detail;
  return `${icon} ${JOURNEY_LABEL[r.id]}: ${what}`;
}

/** Split lines into chunks under `max` characters. A single line longer than `max` is hard-wrapped, not dropped. */
export function chunkLines(lines: readonly string[], max: number): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const raw of lines) {
    const pieces = raw.length <= max ? [raw] : (raw.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")) ?? [raw]);
    for (const piece of pieces) {
      if (cur.length > 0 && cur.length + 1 + piece.length > max) {
        chunks.push(cur);
        cur = "";
      }
      cur = cur.length > 0 ? `${cur}\n${piece}` : piece;
    }
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}

export function composeMorningReport(
  results: readonly JourneyResult[],
  health: { ok: boolean; lines: readonly string[] },
  creditLine: string,
): string[] {
  const byId = new Map(results.map((r) => [r.id, r]));
  const green = (ids: readonly JourneyId[]) => ids.filter((id) => byId.get(id)?.status === "green").length;
  const header =
    `Morning check: ${green(DAILY)}/${DAILY.length} daily journeys green, A–C ${green(NIGHTLY)}/${NIGHTLY.length} green. ` +
    `Health ${health.ok ? "all green" : "has red lines"}.`;
  const reds = results.filter((r) => r.status !== "green").map(line);
  const greens = results.filter((r) => r.status === "green").map(line);
  const body = [header, "", ...reds, ...greens, "", "Health:", ...health.lines];
  if (creditLine) body.push("", creditLine);
  const chunks = chunkLines(body, TELEGRAM_CHUNK_CHARS - 10);
  return chunks.length === 1 ? chunks : chunks.map((c, i) => `(${i + 1}/${chunks.length})\n${c}`);
}
