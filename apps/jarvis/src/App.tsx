import { useCallback, useEffect, useRef, useState } from "react";

const SESSION_ID = "jarvis-desktop";
const DEPARTMENTS = ["research", "comms", "engineering", "marketing", "sales", "personal", "jobhunt"];

interface StreamLine {
  id: string;
  type: string;
  text: string;
  ts: string;
}

interface MissionRow {
  title: string;
  phase: string;
  goal: string;
  dashboard?: string;
}

export function App() {
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<StreamLine[]>([]);
  const [missions, setMissions] = useState<MissionRow[]>([]);
  const [pendingHitl, setPendingHitl] = useState<{ title: string; summary: string } | null>(null);
  const [connected, setConnected] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  const pushLine = useCallback((type: string, text: string) => {
    setLines((prev) => [
      ...prev,
      { id: `${Date.now()}-${prev.length}`, type, text, ts: new Date().toLocaleTimeString() },
    ]);
  }, []);

  const refreshMissions = useCallback(async () => {
    const res = await fetch("/api/v1/missions");
    if (!res.ok) return;
    const data = (await res.json()) as { missions: MissionRow[] };
    setMissions(data.missions ?? []);
  }, []);

  useEffect(() => {
    refreshMissions();
    const es = new EventSource(`/api/v1/sessions/${SESSION_ID}/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data) as { type: string; data?: Record<string, unknown> };
        if (payload.type === "hitl.pending") {
          setPendingHitl({
            title: String(payload.data?.title ?? "Approval required"),
            summary: String(payload.data?.summary ?? ""),
          });
        }
        if (payload.type === "turn.complete") {
          setPendingHitl(null);
          const reply = payload.data?.reply ?? payload.data?.replyHtml;
          if (reply) pushLine("assistant", String(reply));
        }
        if (payload.type === "department.routed") {
          pushLine("system", `Routed: ${String(payload.data?.hint ?? "supervisor")}`);
        }
        if (payload.type === "mission.updated") {
          void refreshMissions();
        }
        if (payload.type === "tool.start" || payload.type === "tool.end") {
          pushLine("tool", JSON.stringify(payload.data ?? {}));
        }
      } catch {
        pushLine("system", ev.data);
      }
    };
    return () => es.close();
  }, [pushLine, refreshMissions]);

  useEffect(() => {
    feedRef.current?.scrollTo(0, feedRef.current.scrollHeight);
  }, [lines]);

  async function sendMessage() {
    const text = input.trim();
    if (!text) return;
    pushLine("user", text);
    setInput("");
    await fetch(`/api/v1/sessions/${SESSION_ID}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
  }

  async function startMission() {
    const goal = window.prompt("Mission goal?");
    if (!goal?.trim()) return;
    await fetch(`/api/v1/sessions/${SESSION_ID}/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: goal.trim() }),
    });
    await refreshMissions();
    pushLine("system", `Mission opened: ${goal}`);
  }

  async function hitl(decision: "approve" | "reject") {
    await fetch(`/api/v1/sessions/${SESSION_ID}/hitl/${decision}`, { method: "POST" });
    setPendingHitl(null);
    pushLine("system", `HITL ${decision}`);
  }

  return (
    <div className="jarvis">
      <header className="hud-header">
        <div className="logo">◆ FounderOS JARVIS</div>
        <div className={`status ${connected ? "live" : "off"}`}>{connected ? "LINKED" : "OFFLINE"}</div>
      </header>

      <aside className="dept-rail">
        {DEPARTMENTS.map((d) => (
          <div key={d} className="dept-orb" title={d}>
            <span>{d.slice(0, 3)}</span>
          </div>
        ))}
      </aside>

      <main className="chat-panel">
        <div className="feed" ref={feedRef}>
          {lines.length === 0 && (
            <p className="placeholder">Talk to your office. Streaming tool calls and routing appear here.</p>
          )}
          {lines.map((l) => (
            <div key={l.id} className={`line line-${l.type}`}>
              <time>{l.ts}</time>
              <span>{l.text}</span>
            </div>
          ))}
        </div>
        <div className="composer">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void sendMessage()}
            placeholder="Command the office…"
          />
          <button type="button" onClick={() => void sendMessage()}>Send</button>
        </div>
      </main>

      <aside className="mission-rail">
        <div className="rail-head">
          <h2>MISO</h2>
          <button type="button" className="ghost" onClick={() => void startMission()}>+ Mission</button>
        </div>
        {missions.slice(0, 5).map((m, i) => (
          <div key={i} className="mission-card">
            <div className="phase">{m.phase}</div>
            <div className="goal">{m.goal ?? m.title}</div>
          </div>
        ))}
        {pendingHitl && (
          <div className="hitl-modal">
            <h3>{pendingHitl.title}</h3>
            <p>{pendingHitl.summary}</p>
            <div className="hitl-actions">
              <button type="button" onClick={() => void hitl("approve")}>Approve</button>
              <button type="button" className="reject" onClick={() => void hitl("reject")}>Reject</button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
