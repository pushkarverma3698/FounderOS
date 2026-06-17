"use client";

import { motion, AnimatePresence } from "framer-motion";
import type { HitlPending } from "@/hooks/useJarvisStream";
import type { MissionRow } from "@/lib/jarvis-api";

export function MissionPanel({
  missions,
  pendingHitl,
  onNewMission,
  onHitl,
}: {
  missions: MissionRow[];
  pendingHitl: HitlPending | null;
  onNewMission: () => void;
  onHitl: (d: "approve" | "reject") => void;
}) {
  return (
    <aside className="mission-panel glass-panel">
      <div className="panel-label">
        <span>MISO CONTROL</span>
        <button type="button" className="ghost-btn" onClick={onNewMission}>
          + MISSION
        </button>
      </div>

      <div className="mission-list">
        {missions.slice(0, 6).map((m, i) => (
          <motion.div
            key={`${m.title}-${i}`}
            className="mission-card"
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.05 }}
          >
            <div className="mission-phase">{m.phase}</div>
            <div className="mission-goal">{m.goal ?? m.title}</div>
          </motion.div>
        ))}
        {missions.length === 0 && (
          <p className="mission-empty">No active missions. Open one to track multi-step work.</p>
        )}
      </div>

      <AnimatePresence>
        {pendingHitl && (
          <motion.div
            className="hitl-card"
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
          >
            <div className="hitl-glow" />
            <div className="hitl-label">HUMAN APPROVAL REQUIRED</div>
            <h3>{pendingHitl.title}</h3>
            <p>{pendingHitl.summary}</p>
            <div className="hitl-actions">
              <button type="button" className="approve-btn" onClick={() => onHitl("approve")}>
                ✓ AUTHORIZE
              </button>
              <button type="button" className="reject-btn" onClick={() => onHitl("reject")}>
                ✕ DENY
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </aside>
  );
}
