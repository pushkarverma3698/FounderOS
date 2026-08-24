import { useState } from 'react';
import { soundEngine } from '../audio/soundEngine';
import type { TraceEventItem } from './TraceWaterfall';
import { SpotlightCard } from './magic/SpotlightCard';
import { TextReveal } from './magic/TextReveal';
import { motion, AnimatePresence } from 'framer-motion';

type Filter = 'ALL' | 'TOOL' | 'LLM' | 'HITL';
const FILTERS: Filter[] = ['ALL', 'TOOL', 'LLM', 'HITL'];

const QUICK_COMMANDS: { label: string; prompt: string }[] = [
  { label: 'Self-audit sweep', prompt: 'Run 3-day self-audit sweep over codebase' },
  { label: 'Job hunt sweep', prompt: 'Screen ATS job boards for software engineer roles' },
  { label: 'Synthesize skill', prompt: 'Synthesize custom web scraping tool' },
  { label: 'Budget report', prompt: 'Display daily spend budget report' },
];

interface RealTimeTerminalProps {
  events: TraceEventItem[];
  onSelectEvent: (event: TraceEventItem) => void;
  onQuickCommand: (prompt: string) => void;
}

export function RealTimeTerminal({
  events,
  onSelectEvent,
  onQuickCommand,
}: RealTimeTerminalProps) {
  const [filter, setFilter] = useState<Filter>('ALL');

  const visible = events.filter((e) => {
    if (filter === 'TOOL') return e.seam.startsWith('tool.');
    if (filter === 'LLM') return e.seam.startsWith('llm.');
    if (filter === 'HITL') return e.seam.startsWith('hitl.');
    return true;
  });

  const seamTone = (seam: string) => {
    if (seam.includes('error') || seam.includes('blocked')) return 'text-alarm border-alarm/40 bg-alarm/5';
    if (seam.includes('hitl')) return 'text-signal border-signal/40 bg-signal/5';
    return 'text-accent border-accent/35 bg-accent/5';
  };

  return (
    <SpotlightCard className="hud-panel h-full flex flex-col p-0 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10 shrink-0 bg-white/5">
        <span className="flex items-center gap-2">
          <span className="w-1.5 h-4 rounded-full bg-accent animate-breathe shadow-[0_0_10px_rgba(0,229,255,0.5)]" />
          <span className="font-sans font-semibold text-[11px] tracking-[0.15em] text-white/90 uppercase">Seam Trace</span>
        </span>

        <div className="flex items-center gap-1 bg-black/40 p-1 rounded-lg border border-white/5">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => {
                soundEngine.click();
                setFilter(f);
              }}
              className={`px-2 py-1 rounded font-sans text-[10px] font-semibold tracking-wider transition-all ${
                filter === f
                  ? 'bg-accent/20 text-accent shadow-[0_0_15px_rgba(0,229,255,0.2)]'
                  : 'text-white/40 hover:text-white/80 hover:bg-white/5'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 relative">
        <AnimatePresence mode="popLayout">
          {visible.length === 0 ? (
            <motion.div 
              key="empty"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="h-full flex flex-col items-center justify-center gap-6 px-6 py-8"
            >
              <div className="flex flex-col items-center gap-4">
                <div className="w-12 h-12 rounded-full border border-accent/20 flex items-center justify-center bg-accent/5 shadow-[inset_0_0_20px_rgba(0,229,255,0.1)]">
                  <span className="w-2 h-2 rounded-full bg-accent animate-ping" />
                </div>
                <TextReveal text="AWAITING KERNEL SEAM EVENTS" className="label-micro text-center !text-accent/60" />
              </div>

              <div className="w-full space-y-2 mt-4">
                <span className="label-micro block !text-white/40">Quick dispatch</span>
                {QUICK_COMMANDS.map((c, i) => (
                  <motion.button
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.1 + i * 0.05 }}
                    key={c.label}
                    onClick={() => {
                      soundEngine.click();
                      onQuickCommand(c.prompt);
                    }}
                    className="w-full px-3 py-2.5 rounded-lg text-left font-mono text-[11px] text-white/60 bg-black/20 border border-white/5 hover:border-accent/40 hover:text-accent hover:bg-accent/10 transition-all truncate flex items-center gap-2 group"
                  >
                    <span className="text-accent/40 group-hover:text-accent transition-colors">›</span>
                    {c.label}
                  </motion.button>
                ))}
              </div>
            </motion.div>
          ) : (
            <div className="flex flex-col">
              {visible.map((ev, i) => (
                <motion.button
                  layout
                  initial={{ opacity: 0, x: -10, filter: 'blur(4px)' }}
                  animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
                  exit={{ opacity: 0, x: 10, filter: 'blur(4px)' }}
                  transition={{ type: 'spring', stiffness: 300, damping: 25 }}
                  key={`${ev.turnId}-${i}`}
                  type="button"
                  onClick={() => {
                    soundEngine.click();
                    onSelectEvent(ev);
                  }}
                  className="w-full px-4 py-3 text-left border-b border-white/5 hover:bg-white/5 transition-colors group relative"
                >
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className={`font-mono text-[10px] font-semibold tracking-wider px-2 py-0.5 rounded border shrink-0 ${seamTone(
                        ev.seam
                      )}`}
                    >
                      {ev.seam}
                    </span>
                    <span className="font-mono text-[10px] text-white/30 tabular-nums shrink-0">
                      {ev.ms}ms · {ev.timestamp}
                    </span>
                  </div>

                  <span className="block mt-2 font-mono text-[11px] text-white/70 truncate">
                    {String(ev.data?.tool ?? ev.data?.agent ?? ev.turnId)}
                    {Boolean(ev.data?.input) && (
                      <span className="text-white/40"> — {String(ev.data?.input)}</span>
                    )}
                  </span>
                </motion.button>
              ))}
            </div>
          )}
        </AnimatePresence>
      </div>
    </SpotlightCard>
  );
}
