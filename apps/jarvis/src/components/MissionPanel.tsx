import { useCallback, useEffect, useState } from "react";
import type { MissionRow } from "../lib/types.js";
import {
  closeMission,
  createMission,
  fetchMisoPlan,
  fetchMisoStatus,
  fetchMissions,
} from "../lib/api.js";

interface MissionPanelProps {
  sessionId: string;
  refreshTick: number;
  onSystemLine: (text: string) => void;
}

export function MissionPanel({ sessionId, refreshTick, onSystemLine }: MissionPanelProps) {
  const [missions, setMissions] = useState<MissionRow[]>([]);
  const [selected, setSelected] = useState<MissionRow | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchMissions();
      const list = data.missions ?? [];
      setMissions(list);
      setSelected((prev) => {
        if (!prev) return list[0] ?? null;
        return list.find((m) => m.missionId === prev.missionId) ?? list[0] ?? null;
      });
    } catch (err) {
      onSystemLine(`Missions error: ${(err as Error).message}`);
    }
  }, [onSystemLine]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshTick]);

  async function startMission() {
    const trimmed = goal.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await createMission(sessionId, trimmed);
      setGoal("");
      setShowForm(false);
      onSystemLine(`Mission opened: ${trimmed}`);
      await refresh();
    } catch (err) {
      onSystemLine(`Mission create failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function runStatus() {
    setBusy(true);
    try {
      const { status } = await fetchMisoStatus(sessionId);
      setDetail(status);
    } catch (err) {
      onSystemLine(`MISO status failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function runPlan() {
    setBusy(true);
    try {
      const { plan } = await fetchMisoPlan(sessionId);
      setDetail(plan);
    } catch (err) {
      onSystemLine(`MISO plan failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function runClose() {
    setBusy(true);
    try {
      const { summary } = await closeMission(sessionId);
      setDetail(summary);
      onSystemLine("Mission closed");
      await refresh();
    } catch (err) {
      onSystemLine(`MISO close failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const dashboard = selected?.dashboard ?? (selected ? `${selected.phase}: ${selected.goal}` : null);

  return (
    <aside className="mission-rail">
      <div className="rail-head">
        <h2>MISO</h2>
        <button type="button" className="ghost" onClick={() => setShowForm((v) => !v)}>
          + Mission
        </button>
      </div>

      {showForm && (
        <div className="mission-form">
          <input
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="Mission goal…"
            onKeyDown={(e) => e.key === "Enter" && void startMission()}
          />
          <button type="button" disabled={busy || !goal.trim()} onClick={() => void startMission()}>
            Open
          </button>
        </div>
      )}

      <div className="mission-actions">
        <button type="button" className="ghost" disabled={busy} onClick={() => void runStatus()}>
          Status
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => void runPlan()}>
          Plan
        </button>
        <button type="button" className="ghost reject" disabled={busy} onClick={() => void runClose()}>
          Close
        </button>
      </div>

      {dashboard && (
        <pre className="mission-dashboard">{dashboard}</pre>
      )}

      {detail && (
        <pre className="mission-detail">{detail}</pre>
      )}

      {missions.slice(0, 5).map((m) => (
        <button
          type="button"
          key={m.missionId ?? m.goal}
          className={`mission-card${selected?.missionId === m.missionId ? " selected" : ""}`}
          onClick={() => setSelected(m)}
        >
          <div className="phase">{m.phase}</div>
          <div className="goal">{m.goal ?? m.title}</div>
        </button>
      ))}
    </aside>
  );
}
