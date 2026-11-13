/**
 * FounderOS — Integration provider types
 * =======================================
 * Stable contracts between tools and platform backends. Tools depend on these
 * shapes — never on gws or LinkedIn REST field names.
 *
 * See ADR-029 (direct platform integrations).
 */


/** Which adapter executes a platform call. Env-selectable; default = direct/gws.
 *  - gws:        Google Workspace CLI on the host (interactive `gws auth login`).
 *  - googleapis: service account + domain-wide delegation (unattended; ADR-029). */
export type GoogleBackend = "gws" | "googleapis";
export type LinkedInBackend = "direct";

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  cc?: string;
  reply_to?: string;
  /** Brand identity — turicks | personal | naggar. Resolved via account registry. */
  account_key?: string;
  /** Department name for default account routing when account_key omitted. */
  department?: string;
}

export interface ReadEmailsInput {
  query: string;
  max_results: number;
  account_key?: string;
  department?: string;
}

export interface CreateCalendarEventInput {
  title: string;
  start_datetime: string;
  end_datetime: string;
  timezone: string;
  description?: string;
  account_key?: string;
  department?: string;
}
