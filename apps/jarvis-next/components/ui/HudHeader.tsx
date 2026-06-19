"use client";

import { motion } from "framer-motion";

export function HudHeader({
  connected,
  voiceOn,
  speaking,
  recognizing,
  onToggleVoice,
}: {
  connected: boolean;
  voiceOn: boolean;
  speaking: boolean;
  recognizing: boolean;
  onToggleVoice: () => void;
}) {
  return (
    <header className="hud-header">
      <div className="hud-brand">
        <motion.span
          className="hud-diamond"
          animate={{ rotate: 360 }}
          transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
        >
          ◆
        </motion.span>
        <div>
          <div className="hud-title">FOUNDEROS</div>
          <div className="hud-sub">JARVIS COMMAND INTERFACE</div>
        </div>
      </div>

      <div className="hud-status-row">
        <div className={`hud-pill ${connected ? "live" : "off"}`}>
          <span className="hud-dot" />
          {connected ? "NEURAL LINK ACTIVE" : "OFFLINE"}
        </div>
        <div className={`hud-pill ${speaking ? "speak" : recognizing ? "listen" : ""}`}>
          {speaking ? "SPEAKING" : recognizing ? "LISTENING" : "VOICE IDLE"}
        </div>
        <button type="button" className={`hud-voice-toggle ${voiceOn ? "on" : ""}`} onClick={onToggleVoice}>
          {voiceOn ? "VOICE ON" : "VOICE OFF"}
        </button>
      </div>
    </header>
  );
}
