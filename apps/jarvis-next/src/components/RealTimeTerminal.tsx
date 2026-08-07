import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Terminal, CornerDownRight, Maximize2, Minimize2 } from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';
import { TraceEventItem } from './TraceWaterfall';

interface RealTimeTerminalProps {
  events: TraceEventItem[];
  onSelectEvent: (event: TraceEventItem) => void;
  dragConstraintsRef: React.RefObject<Element>;
}

export const RealTimeTerminal: React.FC<RealTimeTerminalProps> = ({
  events,
  onSelectEvent,
  dragConstraintsRef,
}) => {
  const [filter, setFilter] = useState<'ALL' | 'TOOL' | 'LLM' | 'HITL'>('ALL');
  const [isMinimized, setIsMinimized] = useState(false);

  const filteredEvents = events.filter((e) => {
    if (filter === 'TOOL') return e.seam.startsWith('tool.');
    if (filter === 'LLM') return e.seam.startsWith('llm.');
    if (filter === 'HITL') return e.seam.startsWith('hitl.');
    return true;
  });

  const getSeamBadgeColor = (seam: string) => {
    if (seam.includes('error') || seam.includes('blocked'))
      return 'bg-red-500/20 text-red-400 border-red-500/40';
    if (seam.includes('hitl'))
      return 'bg-amber-400/20 text-amber-400 border-amber-400/40';
    if (seam.includes('tool'))
      return 'bg-cyan-400/20 text-cyan-400 border-cyan-400/40';
    if (seam.includes('llm'))
      return 'bg-purple-500/20 text-purple-300 border-purple-500/40';
    return 'bg-[#5eead4]/20 text-[#5eead4] border-[#5eead4]/40';
  };

  return (
    <motion.div
      drag
      dragConstraints={dragConstraintsRef}
      dragElastic={0.1}
      whileDrag={{ scale: 1.02 }}
      className="w-full h-full bg-[#0b1624]/85 border border-[#5eead4]/40 shadow-[0_0_30px_rgba(3,6,12,0.9)] backdrop-blur-xl rounded-2xl flex flex-col overflow-hidden font-mono corner-brackets z-30"
    >
      {/* Draggable Terminal Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-[#030712]/90 border-b border-slate-700/60 cursor-grab active:cursor-grabbing select-none">
        <div className="flex items-center space-x-2">
          <Terminal className="w-4 h-4 text-cyan-400" />
          <span className="font-display font-bold text-xs tracking-wider text-slate-100">
            REAL-TIME AGENT TRACE TERMINAL
          </span>
        </div>

        <div className="flex items-center space-x-3">
          {/* Filter Pills */}
          <div className="flex items-center space-x-1 bg-[#0b1624] p-0.5 rounded border border-slate-700/50 text-[10px]">
            {['ALL', 'TOOL', 'LLM', 'HITL'].map((f) => (
              <button
                key={f}
                onClick={() => {
                  soundEngine.click();
                  setFilter(f as 'ALL' | 'TOOL' | 'LLM' | 'HITL');
                }}
                className={`px-2 py-0.5 rounded transition-colors ${
                  filter === f
                    ? 'bg-cyan-400 text-black font-bold'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          <button
            onClick={() => setIsMinimized(!isMinimized)}
            className="p-1 rounded text-slate-400 hover:text-cyan-400 hover:bg-cyan-400/10"
          >
            {isMinimized ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Terminal Stream Body */}
      {!isMinimized && (
        <div className="flex-1 overflow-y-auto p-3 space-y-2 text-xs">
          {filteredEvents.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-slate-500 space-y-4">
              <Terminal className="w-8 h-8 text-cyan-400 opacity-60 animate-pulse" />
              <p className="text-xs text-slate-400">Streaming live kernel trace events over SSE...</p>
              <div className="w-full max-w-sm space-y-2 pt-2 border-t border-slate-800">
                <p className="text-[10px] text-center font-mono text-cyan-400 uppercase tracking-widest font-bold">Quick Executive Commands</p>
                <div className="grid grid-cols-2 gap-2 text-[10px]">
                  <button
                    onClick={() => {
                      soundEngine.click();
                      window.dispatchEvent(new CustomEvent('dispatch-turn', { detail: 'Run 3-day self-audit sweep over codebase' }));
                    }}
                    className="p-2 rounded bg-[#03060c] border border-cyan-400/30 hover:border-cyan-400 text-slate-300 hover:text-cyan-400 transition-all text-left truncate"
                  >
                    ⚡ Self-Audit Sweep
                  </button>
                  <button
                    onClick={() => {
                      soundEngine.click();
                      window.dispatchEvent(new CustomEvent('dispatch-turn', { detail: 'Screen 285 ATS job boards for software engineer roles' }));
                    }}
                    className="p-2 rounded bg-[#03060c] border border-indigo-400/30 hover:border-indigo-400 text-slate-300 hover:text-indigo-400 transition-all text-left truncate"
                  >
                    💼 Job Hunt Sweep
                  </button>
                  <button
                    onClick={() => {
                      soundEngine.click();
                      window.dispatchEvent(new CustomEvent('dispatch-turn', { detail: 'Synthesize custom web scraping tool' }));
                    }}
                    className="p-2 rounded bg-[#03060c] border border-purple-400/30 hover:border-purple-400 text-slate-300 hover:text-purple-400 transition-all text-left truncate"
                  >
                    🤖 Synthesize Skill
                  </button>
                  <button
                    onClick={() => {
                      soundEngine.click();
                      window.dispatchEvent(new CustomEvent('dispatch-turn', { detail: 'Display daily spend budget report' }));
                    }}
                    className="p-2 rounded bg-[#03060c] border border-amber-400/30 hover:border-amber-400 text-slate-300 hover:text-amber-400 transition-all text-left truncate"
                  >
                    📊 Budget Report
                  </button>
                </div>
              </div>
            </div>
          ) : (
            filteredEvents.map((ev, index) => (
              <motion.div
                key={`${ev.turnId}-${index}`}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                onClick={() => {
                  soundEngine.click();
                  onSelectEvent(ev);
                }}
                className="p-2.5 rounded-lg bg-[#03060c]/80 border border-slate-700/40 hover:border-cyan-400/60 cursor-pointer transition-all flex items-start justify-between group"
              >
                <div className="flex items-start space-x-2.5 overflow-hidden">
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded border uppercase font-bold shrink-0 ${getSeamBadgeColor(
                      ev.seam
                    )}`}
                  >
                    {ev.seam}
                  </span>

                  <div className="truncate">
                    <div className="flex items-center space-x-2 text-[11px] text-slate-200">
                      <span className="font-semibold text-slate-300 truncate">
                        {ev.data?.tool
                          ? String(ev.data.tool)
                          : ev.data?.agent
                          ? String(ev.data.agent)
                          : ev.turnId.slice(0, 8)}
                      </span>
                      {Boolean(ev.data?.preview) && (
                        <span className="text-slate-400 truncate max-w-[280px]">
                          &gt; {String(ev.data?.preview)}
                        </span>
                      )}
                    </div>

                    {Boolean(ev.data?.input) && (
                      <div className="text-[10px] text-slate-400 flex items-center space-x-1 mt-0.5">
                        <CornerDownRight className="w-3 h-3 text-slate-500" />
                        <span className="truncate">{String(ev.data?.input)}</span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center space-x-3 text-[10px] text-slate-400 shrink-0">
                  <span className="font-bold text-cyan-400">{ev.ms}ms</span>
                  <span>{ev.timestamp}</span>
                </div>
              </motion.div>
            ))
          )}
        </div>
      )}
    </motion.div>
  );
};
