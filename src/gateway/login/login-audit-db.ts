/** The Postgres-backed login audit. Kept apart from login-audit.ts so the command and its tests never load the validated env. */

import { and, desc, eq } from "drizzle-orm";
import { TENANT } from "../../core/config.js";
import { getDb } from "../../db/client.js";
import { writeAuditEntry } from "../../db/queries.js";
import { actionLog } from "../../db/schema.js";
import { LOGIN_EVENT_ACTION, plainDetail, type LoginAudit, type LoginEvent, type LoginEventKind, type LoginEventRow } from "./login-audit.js";

const KINDS: readonly string[] = ["login", "logout", "remove"];

export const dbLoginAudit: LoginAudit = {
  async record(e) {
    await writeAuditEntry({
      tenant_id: TENANT,
      action: LOGIN_EVENT_ACTION,
      payload: { tool: e.tool, target: e.target, kind: e.kind, ok: e.ok, ...(plainDetail(e.detail) ? { detail: plainDetail(e.detail) } : {}) },
    });
  },
  async recent(limit) {
    const rows = await getDb()
      .select({ payload: actionLog.payload, at: actionLog.created_at })
      .from(actionLog)
      .where(and(eq(actionLog.tenant_id, TENANT), eq(actionLog.action, LOGIN_EVENT_ACTION)))
      .orderBy(desc(actionLog.created_at))
      .limit(limit);
    const out: LoginEventRow[] = [];
    for (const r of rows) {
      const p = r.payload as Partial<LoginEvent> | null;
      if (!p || typeof p.tool !== "string" || typeof p.target !== "string" || !KINDS.includes(String(p.kind)) || r.at === null) continue;
      out.push({ tool: p.tool, target: p.target, kind: p.kind as LoginEventKind, ok: p.ok === true, ...(p.detail ? { detail: p.detail } : {}), at: r.at });
    }
    return out;
  },
};

