/**
 * FounderOS — where the files that must survive a deploy live
 * ============================================================
 * `/opt/founderos` is replaced on every deploy; `/opt/founderos-data` is not. The apply
 * profiles, the discovered-boards CSV and the health and notify records live there.
 * `FOUNDEROS_DATA_ROOT` moves it (a test, another host).
 *
 * One definition. Three modules used to spell out the same expression, and the day one
 * of them changed its default the others would have kept writing to the old place.
 */

/** Where deploy-surviving data lives when FOUNDEROS_DATA_ROOT is not set. */
export const DEFAULT_DATA_ROOT = "/opt/founderos-data";

/** Trimmed `FOUNDEROS_DATA_ROOT`; the default when it is unset or blank. Read at call time so a test can move it. */
export function dataRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env["FOUNDEROS_DATA_ROOT"]?.trim() || DEFAULT_DATA_ROOT;
}
