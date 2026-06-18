import { useState } from "react";
import { ApiError, hitlDecision, sendMessage } from "./lib/api.js";
import { SESSION_ID } from "./lib/types.js";
import { useOfficeStream } from "./hooks/useOfficeStream.js";
import { HudHeader } from "./components/HudHeader.js";
import { DeptRail } from "./components/DeptRail.js";
import { ChatFeed } from "./components/ChatFeed.js";
import { Composer } from "./components/Composer.js";
import { MissionPanel } from "./components/MissionPanel.js";
import { AuditPanel } from "./components/AuditPanel.js";
import { HitlModalContainer } from "./components/HitlModal.js";

export function App() {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const {
    lines,
    connected,
    activeDept,
    pendingHitl,
    setPendingHitl,
    missionTick,
    auditTick,
    pushLine,
  } = useOfficeStream(SESSION_ID);

  async function handleSend() {
    const text = input.trim();
    if (!text || sending) return;
    pushLine("user", text);
    setInput("");
    setSending(true);
    try {
      await sendMessage(SESSION_ID, text);
    } catch (err) {
      const msg = err instanceof ApiError ? `Send failed (${err.status})` : (err as Error).message;
      pushLine("error", msg);
    } finally {
      setSending(false);
    }
  }

  async function handleHitl(decision: "approve" | "reject") {
    try {
      await hitlDecision(SESSION_ID, decision);
      setPendingHitl(null);
      pushLine("system", `HITL ${decision}`);
    } catch (err) {
      pushLine("error", `HITL ${decision} failed: ${(err as Error).message}`);
    }
  }

  return (
    <div className="jarvis">
      <HudHeader connected={connected} />
      <DeptRail activeDept={activeDept} />
      <main className="chat-panel">
        <ChatFeed lines={lines} />
        <Composer
          input={input}
          sending={sending}
          onChange={setInput}
          onSend={() => void handleSend()}
        />
        <AuditPanel refreshTick={auditTick} />
      </main>
      <div className="right-rail">
        <MissionPanel
          sessionId={SESSION_ID}
          refreshTick={missionTick}
          onSystemLine={(text) => pushLine("system", text)}
        />
        <HitlModalContainer pending={pendingHitl} onDecision={handleHitl} />
      </div>
    </div>
  );
}
