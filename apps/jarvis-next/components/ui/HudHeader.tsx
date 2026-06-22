"use client";

import { motion } from "framer-motion";

export function HudHeader({
  connected,
  voiceOn,
  speaking,
  recognizing,
  onToggleVoice,
  sfxOn,
  onToggleSfx,
}: {
  connected: boolean;
  voiceOn: boolean;
  speaking: boolean;
  recognizing: boolean;
  onToggleVoice: () => void;
  sfxOn: boolean;
  onToggleSfx: () => void;
}) {
  return (
    <motion.header 
      className="hud-header"
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="hud-brand">
        <motion.span
          className="hud-diamond"
          animate={{ rotate: [0, 360] }}
          transition={{ duration: 30, repeat: Infinity, ease: "linear" }}
        >
          ◇
        </motion.span>
        <div>
          <h1 className="hud-title">FOUNDER.OS</h1>
          <div className="hud-sub">COGNITIVE SYSTEM LINK</div>
        </div>
      </div>

      <div className="hud-status-row">
        <div className={`hud-pill ${connected ? "live" : "off"}`}>
          <span className="hud-dot" />
          {connected ? "LINKED" : "OFFLINE"}
        </div>
        <div className={`hud-pill ${speaking ? "speak" : recognizing ? "listen" : ""}`}>
          {speaking ? "AI RESPONDING" : recognizing ? "LISTENING" : "STANDBY"}
        </div>
        <button 
          type="button" 
          className={`hud-voice-toggle ${voiceOn ? "on" : ""}`} 
          onClick={onToggleVoice}
        >
          {voiceOn ? "VOICE ON" : "VOICE OFF"}
        </button>
        <button 
          type="button" 
          className={`hud-voice-toggle ${sfxOn ? "on" : ""}`} 
          onClick={onToggleSfx}
        >
          {sfxOn ? "SFX ON" : "SFX OFF"}
        </button>
      </div>
    </motion.header>
  );
}
