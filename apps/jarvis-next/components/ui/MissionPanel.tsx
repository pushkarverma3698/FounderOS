"use client";

import { useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import type { HitlPending } from "@/hooks/useJarvisStream";
import type { MissionRow } from "@/lib/jarvis-api";

export function MissionPanel({
  missions,
  pendingHitl,
  onCreateMission,
  onHitl,
  isBlurred,
  onFocus,
  onBlur,
  mouseOffset = { x: 0, y: 0 },
}: {
  missions: MissionRow[];
  pendingHitl: HitlPending | null;
  onCreateMission: (goal: string) => void;
  onHitl: (d: "approve" | "reject") => void;
  isBlurred?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  mouseOffset?: { x: number; y: number };
}) {
  const prefersReduced = useReducedMotion();
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState("");

  const submit = () => {
    const goal = draft.trim();
    if (!goal) return;
    onCreateMission(goal);
    setDraft("");
    setComposing(false);
  };

  // Mouse-parallax drift, neutralised under reduced-motion.
  const driftX = prefersReduced ? 0 : mouseOffset.x * -8;
  const driftY = prefersReduced ? 0 : mouseOffset.y * -8 + Math.cos(Date.now() / 2500) * 4;

  return (
    <motion.aside
      className={`mission-panel glass-panel ${isBlurred ? "blurred" : ""}`}
      onMouseEnter={onFocus}
      onMouseLeave={onBlur}
      animate={{ x: driftX, y: driftY }}
      transition={{ type: "spring", stiffness: 40, damping: 20 }}
    >
      <div className="panel-label">
        <span>MISSION CONTROL</span>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => setComposing((c) => !c)}
          aria-expanded={composing}
        >
          {composing ? "✕ CLOSE" : "+ MISSION"}
        </button>
      </div>

      <AnimatePresence initial={false}>
        {composing && (
          <motion.div
            className="mission-compose"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
                if (e.key === "Escape") setComposing(false);
              }}
              placeholder="Define mission objective…"
              aria-label="Mission objective"
            />
            <button
              type="button"
              className="send-btn"
              onClick={submit}
              disabled={!draft.trim()}
            >
              OPEN
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mission-list">
        {missions.slice(0, 6).map((m, i) => (
          <motion.div
            key={`${m.title}-${i}`}
            className="mission-card"
            initial={{ opacity: 0, x: 10, filter: "blur(3px)" }}
            animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
            transition={{ 
              delay: i * 0.08,
              duration: 0.8,
              ease: [0.16, 1, 0.3, 1]
            }}
          >
            <div className="mission-phase">{m.phase}</div>
            <div className="mission-goal">{m.goal ?? m.title}</div>
          </motion.div>
        ))}
        {missions.length === 0 && (
          <p className="mission-empty">No active operations. Trigger mission mapping.</p>
        )}
      </div>

      <AnimatePresence>
        {pendingHitl && (
          <motion.div
            className="hitl-card"
            initial={{ opacity: 0, scale: 0.95, y: 15 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -10 }}
            transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="hitl-glow" />
            <div className="hitl-label">NEURAL CONFIRMATION REQUIRED</div>
            <h3>{pendingHitl.title}</h3>
            <p>{pendingHitl.summary}</p>
            <div className="hitl-actions">
              <button 
                type="button" 
                className="approve-btn" 
                onClick={() => onHitl("approve")}
              >
                ✓ AUTHORIZE
              </button>
              <button 
                type="button" 
                className="reject-btn" 
                onClick={() => onHitl("reject")}
              >
                ✕ DENY
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.aside>
  );
}
