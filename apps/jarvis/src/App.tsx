import { useState, useCallback } from "react";
import { ApiError, fetchTtsAudio, hitlDecision, sendMessage, sendVoice } from "./lib/api.js";
import { SESSION_ID } from "./lib/types.js";
import { useOfficeStream } from "./hooks/useOfficeStream.js";
import { useVoiceRecorder } from "./hooks/useVoiceRecorder.js";
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
  const [voiceReply, setVoiceReply] = useState(false);
  const { recording, start: startRecording, stop: stopRecording } = useVoiceRecorder();

  const speakReply = useCallback(async (text: string) => {
    if (!voiceReply || !text.trim()) return;
    try {
      const blob = await fetchTtsAudio(text.slice(0, 500));
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.onended = () => URL.revokeObjectURL(url);
      await audio.play();
    } catch {
      /* TTS optional — text reply already visible */
    }
  }, [voiceReply]);

  const {
    lines,
    connected,
    activeDept,
    pendingHitl,
    setPendingHitl,
    missionTick,
    auditTick,
    pushLine,
  } = useOfficeStream(SESSION_ID, { onAssistantReply: (t) => void speakReply(t) });

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

  async function handleVoiceToggle() {
    if (recording) {
      setSending(true);
      try {
        const blob = await stopRecording();
        if (!blob) {
          pushLine("error", "No audio captured");
          return;
        }
        const result = await sendVoice(SESSION_ID, blob);
        if (result.englishText) pushLine("user", `🎙 ${result.englishText}`);
      } catch (err) {
        const msg = err instanceof ApiError ? `Voice failed (${err.status})` : (err as Error).message;
        pushLine("error", msg);
      } finally {
        setSending(false);
      }
      return;
    }
    const ok = await startRecording();
    if (!ok) pushLine("error", "Microphone unavailable — check browser permissions");
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
      <HudHeader connected={connected} voiceReply={voiceReply} onVoiceReplyToggle={() => setVoiceReply((v) => !v)} />
      <DeptRail activeDept={activeDept} />
      <main className="chat-panel">
        <ChatFeed lines={lines} />
        <Composer
          input={input}
          sending={sending}
          recording={recording}
          onChange={setInput}
          onSend={() => void handleSend()}
          onVoiceToggle={() => void handleVoiceToggle()}
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
