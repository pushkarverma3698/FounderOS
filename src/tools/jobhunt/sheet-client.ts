/**
 * FounderOS — Google Sheets writer
 * ================================
 * The thinnest possible client: authenticate, clear a tab, write a tab. Two
 * REST calls against an API surface this repo uses nowhere else.
 *
 * NO NEW DEPENDENCY. `google-auth-library` is already here for calendar/gmail,
 * and the two endpoints below are stable, documented URLs. Pulling in
 * `@googleapis/sheets` to reach them would add a package to lockfile, CI and
 * audit surface for two fetch calls.
 *
 * CLEAR-THEN-WRITE, not write-over. `values.update` overwrites the range it is
 * given and leaves anything past it untouched, so a sweep that returns fewer
 * rows than the last one would leave the tail of the previous queue on screen —
 * jobs the founder already applied to, sitting under a heading that says these
 * are the ones to do next. The clear is what makes the sheet a view of the
 * database rather than an append-only pile.
 */

import { GoogleAuth } from "google-auth-library";
import { childLogger } from "../../infra/logger.js";
import type { Cell } from "./sheet-rows.js";

const log = childLogger({ module: "jobhunt:sheet-client" });

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

/** How long one Sheets call may take before it is a failure rather than a wait. */
export const SHEETS_TIMEOUT_MS = 20_000;

export interface SheetTarget {
  readonly spreadsheetId: string;
  readonly credentialsPath: string;
}

/**
 * Write one tab: clear whatever is there, then put these rows at A1.
 *
 * Throws on any non-2xx. The caller turns that into a ⚠ alert — a Sheet that
 * silently failed to update is worse than no Sheet, because the founder would
 * work from yesterday's queue believing it was today's.
 */
export async function writeTab(
  target: SheetTarget,
  tabName: string,
  rows: readonly Cell[][],
): Promise<void> {
  const token = await accessToken(target.credentialsPath);
  const range = encodeURIComponent(`${tabName}!A1:ZZ`);

  await ensureTab(token, target.spreadsheetId, tabName);
  await sheetsCall(token, `${SHEETS_BASE}/${target.spreadsheetId}/values/${range}:clear`, {});
  await sheetsCall(
    token,
    `${SHEETS_BASE}/${target.spreadsheetId}/values/${range}?valueInputOption=RAW`,
    { values: rows },
    "PUT",
  );

  log.info({ tab: tabName, rows: rows.length }, "Sheet tab written");
}

/**
 * Create the tab if the spreadsheet does not have it yet.
 *
 * A blank Google Sheet contains exactly one tab called "Sheet1", so on a sheet
 * the founder has just created BOTH our tabs are missing and every write fails
 * with "Unable to parse range" — a ⚠ every thirty minutes, forever, for a
 * spreadsheet that exists and is correctly shared. Asking him to hand-create
 * two tabs with exact names is a setup step that silently breaks on a typo.
 *
 * Idempotent by checking first: addSheet on an existing title is a 400.
 */
async function ensureTab(token: string, spreadsheetId: string, tabName: string): Promise<void> {
  const response = await fetch(
    `${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties.title`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new Error(`Sheets API ${response.status} reading tabs: ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as { sheets?: { properties?: { title?: string } }[] };
  const titles = (body.sheets ?? []).map((sheet) => sheet.properties?.title);
  if (titles.includes(tabName)) return;

  await sheetsCall(token, `${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
    requests: [{ addSheet: { properties: { title: tabName } } }],
  });
  log.info({ tab: tabName }, "Sheet tab created");
}

/**
 * A bearer token for the service account.
 *
 * Not cached. A sweep writes two tabs every thirty minutes, so this runs 96
 * times a day — the library caches the underlying token itself, and a cache of
 * our own would be one more thing that can hold a stale credential after a key
 * rotation.
 */
async function accessToken(credentialsPath: string): Promise<string> {
  const auth = new GoogleAuth({ keyFile: credentialsPath, scopes: [SHEETS_SCOPE] });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) {
    throw new Error(
      `Google refused a token for the service account in ${credentialsPath}. ` +
        "The key may have been rotated or deleted.",
    );
  }
  return token;
}

/** One Sheets REST call, with a timeout and an error that names what failed. */
async function sheetsCall(
  token: string,
  url: string,
  body: unknown,
  method: "POST" | "PUT" = "POST",
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SHEETS_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      // The body carries Google's own diagnosis ("The caller does not have
      // permission" vs "Unable to parse range"), and those need opposite fixes.
      // Dropping it would leave the founder with a status code.
      // We are already throwing; a body we cannot read costs the diagnosis, and
      // allow-failopen: losing the status code as well would be strictly worse.
      const detail = await response.text().catch(() => "");
      throw new Error(`Sheets API ${response.status}: ${detail.slice(0, 300)}`);
    }
    // The write SUCCEEDED — this only releases the socket. Letting a cancel
    // failure propagate would report a completed write as a failed one, and the
    // caller would tell the founder the sheet is stale when it is current.
    // allow-failopen: a released-socket failure must not invalidate a real write.
    await response.body?.cancel().catch(() => {});
  } finally {
    clearTimeout(timer);
  }
}
