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
}: {
  lines: ChatLine[];
  input: string;
  busy?: boolean;
  onInputChange: (v: string) => void;
  onSend: () => void;
  onVoiceStart: () => void;
  recognizing: boolean;
}) {
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  return (
    <section className="chat-panel glass-panel">
      <div className="panel-label">
        <span>COMMS CHANNEL</span>
        <span className="panel-tag">AES-256</span>
      </div>
      <div className="feed" ref={feedRef}>
        <AnimatePresence initial={false}>
          {lines.length === 0 && (
            <motion.p
              key="placeholder"
              className="feed-placeholder"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
            >
              Awaiting your command, sir. Voice or text — the office is listening.
            </motion.p>
          )}
          {lines.map((l) => (
            <motion.div
              key={l.id}
              className={`feed-line feed-${l.type}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25 }}
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
          placeholder={busy ? "Office processing…" : "Command the office…"}
          aria-label="Message"
        />
        <button type="button" className="send-btn" onClick={onSend} disabled={busy}>
          {busy ? "…" : "TRANSMIT"}
        </button>
      </div>
    </section>
  );
}
