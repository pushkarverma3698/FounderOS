"use client";

import { useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { ChatLine } from "@/hooks/useJarvisStream";

export function ChatPanel({
  lines,
  input,
  busy,
  onInputChange,
  onSend,
  onVoiceStart,
  recognizing,
  isBlurred,
  onFocus,
  onBlur,
  mouseOffset = { x: 0, y: 0 },
}: {
  lines: ChatLine[];
  input: string;
  busy?: boolean;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onVoiceStart: () => void;
  recognizing: boolean;
  isBlurred?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  mouseOffset?: { x: number; y: number };
}) {
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  return (
    <motion.section
      className={`chat-panel glass-panel ${isBlurred ? "blurred" : ""}`}
      onMouseEnter={onFocus}
      onMouseLeave={onBlur}
      animate={{
        x: mouseOffset.x * -12,
        y: (mouseOffset.y * -12) + Math.sin(Date.now() / 2500) * 4,
      }}
      transition={{ type: "spring", stiffness: 40, damping: 20 }}
    >
      <div className="panel-label">
        <span>COMMUNICATION LINK</span>
        <span className="panel-tag">SECURE CHANNEL</span>
      </div>

      <div className="feed" ref={feedRef}>
        <AnimatePresence initial={false}>
          {lines.length === 0 && (
            <motion.p
              key="placeholder"
              className="feed-placeholder"
              initial={{ opacity: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)" }}
              transition={{ duration: 1.2 }}
            >
              System fully initialized. Standing by for instructions.
            </motion.p>
          )}
          {lines.map((l) => (
            <motion.div
              key={l.id}
              className={`feed-line feed-${l.type}`}
              initial={{ opacity: 0, y: 12, filter: "blur(4px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1] }}
            >
              <time>{l.ts}</time>
              <span>{l.text}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <div className="composer">
        <button
          type="button"
          className={`mic-btn ${recognizing ? "active" : ""}`}
          onClick={onVoiceStart}
          title="Voice command"
          aria-label="Voice command"
        >
          {recognizing ? "◉" : "🎙"}
        </button>
        <input
          value={input}
          disabled={busy}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !busy && onSend()}
          placeholder={busy ? "AI processing..." : "Initialize connection..."}
          aria-label="Message"
        />
        <button 
          type="button" 
          className="send-btn" 
          onClick={onSend} 
          disabled={busy}
        >
          {busy ? "···" : "TRANSMIT"}
        </button>
      </div>
    </motion.section>
  );
}
