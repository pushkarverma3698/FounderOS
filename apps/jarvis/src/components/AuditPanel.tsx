import { useCallback, useEffect, useState } from "react";
import type { AuditEntry } from "../lib/types.js";
import { fetchAudit } from "../lib/api.js";

interface AuditPanelProps {
  refreshTick: number;
}

export function AuditPanel({ refreshTick }: AuditPanelProps) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchAudit();
      setEntries(data.entries ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh, refreshTick]);

  return (
    <section className="audit-panel">
      <button type="button" className="ghost audit-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? "Hide Audit" : "Audit Log"}
      </button>
      {open && (
        <div className="audit-list">
          {error && <p className="error-text">{error}</p>}
          {entries.length === 0 && !error && <p className="muted">No recent actions.</p>}
          {entries.slice(0, 10).map((e, i) => (
            <div key={`${e.idempotency_key ?? e.action}-${i}`} className="audit-row">
              <span className="audit-action">{e.action}</span>
              {e.created_at && (
                <time>{new Date(e.created_at).toLocaleTimeString()}</time>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
