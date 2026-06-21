"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import type { ChatLine } from "@/hooks/useJarvisStream";

const COGNITIVE_STATES = [
  "ROUTING COGNITIVE SYNAPSES...",
  "QUERYING INTERNAL KNOWLEDGE GRAPH...",
  "SYNTHESIZING SYSTEM CONTROLS...",
  "RESOLVING MULTI-AGENT PROTOCOLS...",
  "EVALUATING ACTION VIABILITY...",
  "COMPILING RESPONSE STRUCTURE...",
];

type ChatEntry = 
  | { type: "user" | "assistant" | "error"; line: ChatLine }
  | { type: "thought_group"; id: string; steps: ChatLine[]; ts: string };

function groupChatLines(lines: ChatLine[]): ChatEntry[] {
  const result: ChatEntry[] = [];
  let currentGroup: ChatLine[] = [];

  const flushGroup = () => {
    if (currentGroup.length > 0) {
      result.push({
        type: "thought_group",
        id: `group-${currentGroup[0].id}`,
        steps: [...currentGroup],
        ts: currentGroup[0].ts,
      });
      currentGroup = [];
    }
  };

  for (const line of lines) {
    if (line.type === "system" || line.type === "tool") {
      currentGroup.push(line);
    } else {
      flushGroup();
      result.push({ type: line.type, line });
    }
  }
  flushGroup();
  return result;
}

function ThoughtProcessAccordion({
  group,
  defaultOpen,
}: {
  group: { id: string; steps: ChatLine[]; ts: string };
  defaultOpen: boolean;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  useEffect(() => {
    if (defaultOpen) {
      setIsOpen(true);
    }
  }, [defaultOpen]);

  return (
    <div className={`thought-accordion ${isOpen ? "open" : ""}`}>
      <button
        type="button"
        className="thought-header"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="thought-header-left">
          <span className="thought-pulse" />
          <span className="thought-title">
            COGNITIVE FLOW ({group.steps.length} {group.steps.length === 1 ? "STEP" : "STEPS"})
          </span>
        </div>
        <div className="thought-header-right">
          <time className="thought-time">{group.ts}</time>
          <span className="thought-chevron">{isOpen ? "▲" : "▼"}</span>
        </div>
      </button>
      
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
            className="thought-steps-wrapper"
          >
            <div className="thought-steps">
              {group.steps.map((step) => {
                let displayText = step.text;
                if (step.type === "tool") {
                  try {
                    const parsed = JSON.parse(step.text);
                    if (parsed.status || parsed.notice) {
                      displayText = parsed.status || parsed.notice;
                    } else if (parsed.name) {
                      displayText = `Invoking: ${parsed.name}`;
                    } else {
                      displayText = `Process details: ${JSON.stringify(parsed)}`;
                    }
                  } catch {
                    // Ignore parsing error, keep text
                  }
                }
                return (
                  <div key={step.id} className={`thought-step thought-step-${step.type}`}>
                    <span className="step-bullet">↳</span>
                    <span className="step-text">{displayText}</span>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

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
  const prefersReduced = useReducedMotion();
  const [tickerIndex, setTickerIndex] = useState(0);
  const [activeStatus, setActiveStatus] = useState<string | null>(null);
  const lastLineCountRef = useRef(lines.length);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: "smooth" });
  }, [lines]);

  // Cycle simulated states
  useEffect(() => {
    if (!busy) {
      setActiveStatus(null);
      return;
    }
    const interval = setInterval(() => {
      setTickerIndex((prev) => (prev + 1) % COGNITIVE_STATES.length);
      setActiveStatus(null);
    }, 2500);
    return () => clearInterval(interval);
  }, [busy]);

  // Capture actual incoming steps as temporary active status
  useEffect(() => {
    if (lines.length > lastLineCountRef.current) {
      const lastLine = lines[lines.length - 1];
      if (lastLine.type === "system" || lastLine.type === "tool") {
        let text = lastLine.text;
        if (lastLine.type === "tool") {
          try {
            const parsed = JSON.parse(lastLine.text);
            text = parsed.status || parsed.notice || `Running tool: ${parsed.name || "agent"}`;
          } catch {
            // Ignore
          }
        }
        setActiveStatus(text.toUpperCase());
      }
      lastLineCountRef.current = lines.length;
    }
  }, [lines]);

  const currentCognitiveState = activeStatus || COGNITIVE_STATES[tickerIndex];
  const groupedEntries = groupChatLines(lines);

  return (
    <motion.section
      className={`chat-panel glass-panel ${isBlurred ? "blurred" : ""}`}
      onMouseEnter={onFocus}
      onMouseLeave={onBlur}
      animate={{
        x: prefersReduced ? 0 : mouseOffset.x * -12,
        y: prefersReduced ? 0 : mouseOffset.y * -12 + Math.sin(Date.now() / 2500) * 4,
      }}
      transition={{ type: "spring", stiffness: 40, damping: 20 }}
    >
      <div className="panel-label">
        <span>COMMUNICATION LINK</span>
        <span className="panel-tag">SECURE CHANNEL</span>
      </div>

      <div className="feed" ref={feedRef}>
        <AnimatePresence initial={false}>
          {groupedEntries.length === 0 && (
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
          {groupedEntries.map((entry, idx) => {
            if (entry.type === "thought_group") {
              const isActive = !!busy && idx === groupedEntries.length - 1;
              return (
                <motion.div
                  key={entry.id}
                  initial={{ opacity: 0, y: 12, filter: "blur(4px)" }}
                  animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                  transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
                >
                  <ThoughtProcessAccordion group={entry} defaultOpen={isActive} />
                </motion.div>
              );
            }

            const { line } = entry;
            return (
              <motion.div
                key={line.id}
                className={`feed-line feed-${line.type}`}
                initial={{ opacity: 0, y: 12, filter: "blur(4px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={{ duration: 0.65, ease: [0.16, 1, 0.3, 1] }}
              >
                <time>{line.ts}</time>
                <span>{line.text}</span>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      {busy && (
        <div className="cognitive-ticker">
          <span className="ticker-pulse" />
          <span className="ticker-text">{currentCognitiveState}</span>
        </div>
      )}

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
