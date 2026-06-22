"use client";

import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";

const BOOT_LINES = [
  "COGNITIVE SYNAPSE ONLINE",
  "ESTABLISHING SECURE PROTOCOLS",
  "CALIBRATING NEURAL DEPARTMENTS",
  "MISO CORE COGNITION SYNCHRONIZED",
  "FOUNDER.OS ACTIVE",
];

export function CinematicIntro({ onComplete }: { onComplete?: () => void }) {
  const [lineIdx, setLineIdx] = useState(0);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const failSafe = setTimeout(() => onComplete?.(), 5500);
    return () => clearTimeout(failSafe);
  }, [onComplete]);

  useEffect(() => {
    if (lineIdx >= BOOT_LINES.length) {
      const t = setTimeout(() => setDone(true), 900);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setLineIdx((i) => i + 1), 650);
    return () => clearTimeout(t);
  }, [lineIdx]);

  useEffect(() => {
    if (done) {
      const t = setTimeout(() => onComplete?.(), 600);
      return () => clearTimeout(t);
    }
  }, [done, onComplete]);

  return (
    <AnimatePresence>
      {!done && (
        <motion.div
          className="intro-overlay"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, filter: "blur(20px)" }}
          transition={{ duration: 1.6, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="intro-flare" />
          
          <motion.h2
            className="intro-logo"
            initial={{ y: 20, opacity: 0, filter: "blur(5px)" }}
            animate={{ y: 0, opacity: 0.9, filter: "blur(0px)" }}
            transition={{ duration: 1.8, ease: [0.16, 1, 0.3, 1] }}
          >
            FOUNDER.OS
          </motion.h2>

          <div className="intro-lines">
            {BOOT_LINES.slice(0, lineIdx).map((line, i) => (
              <motion.div
                key={line}
                className="intro-line"
                initial={{ opacity: 0, y: 15, filter: "blur(4px)" }}
                animate={{ opacity: 0.7, y: 0, filter: "blur(0px)" }}
                transition={{ duration: 1.0, ease: [0.16, 1, 0.3, 1] }}
                style={{ 
                  fontFamily: "var(--display-font)",
                  fontWeight: i === BOOT_LINES.length - 1 ? 500 : 300,
                  color: i === BOOT_LINES.length - 1 ? "#ffffff" : "var(--muted)"
                }}
              >
                {line}
              </motion.div>
            ))}
          </div>

          <div className="intro-progress">
            <motion.div
              className="intro-progress-bar"
              initial={{ left: "-100%" }}
              animate={{ left: "100%" }}
              transition={{ 
                duration: 3.5, 
                ease: "easeInOut",
                repeat: Infinity 
              }}
              style={{ position: "absolute", width: "100%" }}
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
