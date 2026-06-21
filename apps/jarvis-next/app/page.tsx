"use client";

import { useCallback, useEffect, useState, useMemo } from "react";
import { JarvisScene } from "@/components/scene/JarvisScene";
import { CinematicIntro } from "@/components/ui/CinematicIntro";
import { HudHeader } from "@/components/ui/HudHeader";
import { ChatPanel } from "@/components/ui/ChatPanel";
import { MissionPanel } from "@/components/ui/MissionPanel";
import { DeptRail } from "@/components/ui/DeptRail";
import { useJarvisStream } from "@/hooks/useJarvisStream";
import { useVoice } from "@/hooks/useVoice";
import { createMission, hitlDecision, sendMessage, DEPARTMENTS } from "@/lib/jarvis-api";
import "./dashboard.css";

export const dynamic = "force-dynamic";

export default function JarvisDashboard() {
  const [input, setInput] = useState("");
  const [mouseOffset, setMouseOffset] = useState({ x: 0, y: 0 });
  const [focusedPanel, setFocusedPanel] = useState<"chat" | "missions" | null>(null);

  const { voiceOn, setVoiceOn, speaking, recognizing, speak, startListening } = useVoice();

  // Track mouse coordinates for zero-gravity parallax drift
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const x = (e.clientX / window.innerWidth) - 0.5;
      const y = (e.clientY / window.innerHeight) - 0.5;
      setMouseOffset({ x, y });
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  const onAssistantReply = useCallback(
    (text: string) => {
      if (voiceOn) speak(text);
    },
    [speak, voiceOn],
  );

  const {
    connected,
    busy,
    lines,
    missions,
    pendingHitl,
    activeDept,
    pushLine,
    refreshMissions,
    setPendingHitl,
    markBusy,
    markIdle,
  } = useJarvisStream(onAssistantReply);

  // Map AI cognitive/voice state to smooth ambient backdrop glows
  const glowColors = useMemo(() => {
    if (!connected) {
      return {
        cyanGlow: "rgba(80, 80, 80, 0.04)",
        violetGlow: "rgba(40, 40, 40, 0.02)",
        centerGlow: "rgba(0, 0, 0, 0.0)"
      };
    }
    if (speaking) {
      return {
        cyanGlow: "rgba(255, 200, 87, 0.12)",
        violetGlow: "rgba(251, 191, 36, 0.08)",
        centerGlow: "rgba(255, 200, 87, 0.04)"
      };
    }
    if (recognizing) {
      return {
        cyanGlow: "rgba(78, 240, 255, 0.18)",
        violetGlow: "rgba(92, 255, 176, 0.12)",
        centerGlow: "rgba(78, 240, 255, 0.06)"
      };
    }
    if (busy) {
      return {
        cyanGlow: "rgba(167, 139, 250, 0.22)",
        violetGlow: "rgba(255, 126, 179, 0.12)",
        centerGlow: "rgba(167, 139, 250, 0.06)"
      };
    }
    if (activeDept) {
      const deptObj = DEPARTMENTS.find((d) => activeDept.includes(d.id));
      if (deptObj) {
        return {
          cyanGlow: `${deptObj.color}20`,
          violetGlow: `${deptObj.color}10`,
          centerGlow: `${deptObj.color}04`
        };
      }
    }
    return {
      cyanGlow: "rgba(78, 240, 255, 0.12)",
      violetGlow: "rgba(167, 139, 250, 0.08)",
      centerGlow: "rgba(78, 240, 255, 0.03)"
    };
  }, [connected, speaking, recognizing, busy, activeDept]);

  const transmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || busy) return;
      pushLine("user", trimmed);
      setInput("");
      markBusy();
      try {
        await sendMessage(trimmed);
      } catch {
        markIdle();
        pushLine("error", "Transmission failed — is the gateway running on :3001?");
      }
    },
    [busy, markBusy, markIdle, pushLine],
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

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const w = window as Window & {
      __jarvisQa?: {
        simulateTranscript: (text: string) => void;
        speakTest: () => void;
        voiceInfo: () => { speechRecognition: boolean; tts: boolean; voices: number };
      };
    };
    w.__jarvisQa = {
      simulateTranscript: (text: string) => void transmit(text),
      speakTest: () => speak("JARVIS online. Systems nominal."),
      voiceInfo: () => ({
        speechRecognition: !!(
          (window as Window & { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition ||
          (window as Window & { SpeechRecognition?: unknown }).SpeechRecognition
        ),
        tts: !!window.speechSynthesis,
        voices: window.speechSynthesis?.getVoices().length ?? 0,
      }),
    };
    return () => {
      delete w.__jarvisQa;
    };
  }, [speak, transmit]);

  return (
    <main className="dashboard">
      <div 
        className="ambient-glows" 
        style={{
          "--cyan-glow": glowColors.cyanGlow,
          "--violet-glow": glowColors.violetGlow,
          "--center-glow": glowColors.centerGlow,
        } as React.CSSProperties}
      >
        <div className="ambient-glow glow-top-left" />
        <div className="ambient-glow glow-bottom-right" />
        <div className="ambient-glow glow-center-burst" />
      </div>

      <CinematicIntro />

      <div className="dashboard-inner visible">
        <JarvisScene 
          activeDept={activeDept} 
          speaking={speaking} 
          recognizing={recognizing} 
          busy={busy}
        />

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
                <span className="caption-label">CORE STATE</span>
                <span className="caption-value">
                  {connected ? (busy ? "COGNITION WAVE" : "STABLE SYNC") : "STANDBY"}
                </span>
              </div>
            </div>

            <div className="side-stack">
              <ChatPanel
                lines={lines}
                input={input}
                busy={busy}
                onInputChange={setInput}
                onSend={() => void transmit(input)}
                onVoiceStart={handleVoice}
                recognizing={recognizing}
                isBlurred={focusedPanel !== null && focusedPanel !== "chat"}
                onFocus={() => setFocusedPanel("chat")}
                onBlur={() => setFocusedPanel(null)}
                mouseOffset={mouseOffset}
              />
              <MissionPanel
                missions={missions}
                pendingHitl={pendingHitl}
                onNewMission={() => void handleMission()}
                onHitl={(d) => void handleHitl(d)}
                isBlurred={focusedPanel !== null && focusedPanel !== "missions"}
                onFocus={() => setFocusedPanel("missions")}
                onBlur={() => setFocusedPanel(null)}
                mouseOffset={mouseOffset}
              />
            </div>
          </div>

          <footer className="hud-footer">
            <span>FOUNDER.OS COMMAND</span>
            <span className="footer-sep">·</span>
            <span>AUTONOMOUS MATRIX</span>
          </footer>
        </div>
      </div>
    </main>
  );
}
