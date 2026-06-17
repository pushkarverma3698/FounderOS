"use client";

import { useCallback, useState } from "react";
import { JarvisScene } from "@/components/scene/JarvisScene";
import { CinematicIntro } from "@/components/ui/CinematicIntro";
import { HudHeader } from "@/components/ui/HudHeader";
import { ChatPanel } from "@/components/ui/ChatPanel";
import { MissionPanel } from "@/components/ui/MissionPanel";
import { DeptRail } from "@/components/ui/DeptRail";
import { useJarvisStream } from "@/hooks/useJarvisStream";
import { useVoice } from "@/hooks/useVoice";
import { createMission, hitlDecision, sendMessage } from "@/lib/jarvis-api";
import "./dashboard.css";

export const dynamic = "force-dynamic";

export default function JarvisDashboard() {
  const [introDone, setIntroDone] = useState(false);
  const [input, setInput] = useState("");

  const { voiceOn, setVoiceOn, speaking, recognizing, speak, startListening } = useVoice();

  const onAssistantReply = useCallback(
    (text: string) => {
      if (voiceOn) speak(text);
    },
    [speak, voiceOn],
  );

  const { connected, lines, missions, pendingHitl, activeDept, pushLine, refreshMissions, setPendingHitl } =
    useJarvisStream(onAssistantReply);

  const transmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      pushLine("user", trimmed);
      setInput("");
      try {
        await sendMessage(trimmed);
      } catch {
        pushLine("system", "Transmission failed — is the gateway running on :3001?");
      }
    },
    [pushLine],
  );

  const handleVoice = useCallback(() => {
    const ok = startListening((text) => void transmit(text));
    if (!ok) pushLine("system", "Voice recognition unavailable in this browser.");
  }, [pushLine, startListening, transmit]);

  const handleHitl = useCallback(
    async (decision: "approve" | "reject") => {
      try {
        await hitlDecision(decision);
        setPendingHitl(null);
        pushLine("system", `HITL ${decision.toUpperCase()}`);
        if (voiceOn) speak(decision === "approve" ? "Authorized." : "Denied.");
      } catch {
        pushLine("system", "HITL action failed.");
      }
    },
    [pushLine, setPendingHitl, speak, voiceOn],
  );

  const handleMission = useCallback(async () => {
    const goal = window.prompt("Mission objective?");
    if (!goal?.trim()) return;
    try {
      await createMission(goal.trim());
      await refreshMissions();
      pushLine("system", `Mission opened: ${goal.trim()}`);
      if (voiceOn) speak(`Mission registered: ${goal.trim()}`);
    } catch {
      pushLine("system", "Could not open mission.");
    }
  }, [pushLine, refreshMissions, speak, voiceOn]);

  return (
    <main className="dashboard">
      <CinematicIntro onComplete={() => setIntroDone(true)} />

      <div className={`dashboard-inner ${introDone ? "visible" : ""}`}>
        <JarvisScene activeDept={activeDept} speaking={speaking} recognizing={recognizing} />

        <div className="hud-layer">
          <HudHeader
            connected={connected}
            voiceOn={voiceOn}
            speaking={speaking}
            recognizing={recognizing}
            onToggleVoice={() => setVoiceOn((v) => !v)}
          />

          <div className="hud-body">
            <DeptRail activeDept={activeDept} />

            <div className="center-stack">
              <div className="core-caption">
                <span className="caption-label">CORE STATUS</span>
                <span className="caption-value">{connected ? "SYNCED" : "STANDBY"}</span>
              </div>
            </div>

            <div className="side-stack">
              <ChatPanel
                lines={lines}
                input={input}
                onInputChange={setInput}
                onSend={() => void transmit(input)}
                onVoiceStart={handleVoice}
                recognizing={recognizing}
              />
              <MissionPanel
                missions={missions}
                pendingHitl={pendingHitl}
                onNewMission={() => void handleMission()}
                onHitl={(d) => void handleHitl(d)}
              />
            </div>
          </div>

          <footer className="hud-footer">
            <span>TURICKS AUTONOMOUS STUDIO</span>
            <span className="footer-sep">|</span>
            <span>7 DEPT · HITL GATED · TEMP 0</span>
          </footer>
        </div>
      </div>
    </main>
  );
}
