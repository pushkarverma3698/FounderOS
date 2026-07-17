/**
 * FounderOS — human-readable timestamp formatting
 * ===============================================
 * One place that turns a Date/epoch into a proper, readable UTC stamp
 * ("2026-07-18 01:04:01 UTC"). Used on the message-receive path so logs and
 * founder-facing surfaces never show a raw epoch. UTC always — the box, the
 * founder, and the checkpointer must all agree on one clock.
 */

/**
 * Format a Date or epoch-ms as `YYYY-MM-DD HH:mm:ss UTC`. Total function: an
 * invalid/NaN input yields "invalid-timestamp" rather than throwing — this runs
 * inside log calls on the message-receive path, where a RangeError from
 * `new Date(NaN).toISOString()` would break message handling.
 */
export function formatTimestamp(when: Date | number = new Date()): string {
  const d = typeof when === "number" ? new Date(when) : when;
  if (Number.isNaN(d.getTime())) return "invalid-timestamp";
  const iso = d.toISOString(); // 2026-07-18T01:04:01.500Z — already UTC
  const [date, time] = iso.split("T");
  return `${date} ${time!.slice(0, 8)} UTC`;
}
