"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";

const BOOT_LINES = [
  "FOUNDEROS NEURAL LINK",
  "INITIALIZING OFFICE SUPERVISOR",
  "LOADING 7 DEPARTMENT AGENTS",
  "CALIBRATING MISO MISSION CONTROL",
  "JARVIS INTERFACE ONLINE",
];

export function CinematicIntro({ onComplete }: { onComplete: () => void }) {
  const [lineIdx, setLineIdx] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (lineIdx >= BOOT_LINES.length) {
      const t = setTimeout(() => setDone(true), 600);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setLineIdx((i) => i + 1), 520);
    return () => clearTimeout(t);
  }, [lineIdx]);

  useEffect(() => {
    if (done) {
      const t = setTimeout(onComplete, 400);
      return () => clearTimeout(t);
    }
  }, [done, onComplete]);

  return (
    <AnimatePresence>
      {!done && (
        <motion.div
          className="intro-overlay"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.9, ease: "easeInOut" }}
        >
          <div className="intro-flare" />
          <motion.div
            className="intro-logo"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.8 }}
          >
            ◆ JARVIS
          </motion.div>
          <div className="intro-lines">
            {BOOT_LINES.slice(0, lineIdx).map((line, i) => (
              <motion.div
                key={line}
                className="intro-line"
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.05 }}
              >
                <span className="intro-cursor">▸</span> {line}
              </motion.div>
            ))}
          </div>
          <div className="intro-progress">
            <motion.div
              className="intro-progress-bar"
              initial={{ width: "0%" }}
              animate={{ width: `${(lineIdx / BOOT_LINES.length) * 100}%` }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
