import React, { useState } from 'react';
import { Terminal, Filter, ShieldCheck, AlertCircle, ArrowRight, CornerDownRight } from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';

export interface TraceEventItem {
  turnId: string;
  seam: string;
  ms: number;
  data?: Record<string, unknown>;
  timestamp: string;
}

interface TraceWaterfallProps {
  events: TraceEventItem[];
  onSelectEvent: (event: TraceEventItem) => void;
}

export const TraceWaterfall: React.FC<TraceWaterfallProps> = ({ events, onSelectEvent }) => {
  const [filter, setFilter] = useState<string>('ALL');

  const filteredEvents = events.filter((e) => {
    if (filter === 'TOOL') return e.seam.startsWith('tool.');
    if (filter === 'LLM') return e.seam.startsWith('llm.');
    if (filter === 'HITL') return e.seam.startsWith('hitl.');
    if (filter === 'SEAM') return e.seam.startsWith('turn.') || e.seam.startsWith('route.');
    return true;
  });

  const getSeamBadgeColor = (seam: string) => {
    if (seam.includes('error') || seam.includes('blocked')) return 'bg-red-500/15 text-red-400 border-red-500/30';
    if (seam.includes('hitl')) return 'bg-amberGlow/15 text-amberGlow border-amberGlow/30';
    if (seam.includes('tool')) return 'bg-indigoGlow/15 text-indigoGlow border-indigoGlow/30';
    if (seam.includes('llm')) return 'bg-purple-500/15 text-purple-300 border-purple-500/30';
    return 'bg-[#5eead4]/15 text-[#5eead4] border-[#5eead4]/30';
  };

  return (
    <div className="w-full h-full bg-[#03060c] border border-borderTeal rounded-lg flex flex-col overflow-hidden font-mono">
      {/* Waterfall Control Bar */}
      <div className="flex items-center justify-between px-3 py-2 bg-bg/80 border-b border-borderTeal/60 text-xs">
        <div className="flex items-center space-x-2">
          <Terminal className="w-4 h-4 text-[#5eead4]" />
          <span className="font-display font-bold tracking-wider text-[#dbeaf0]">REAL-TIME KERNEL TRACE WATERFALL</span>
        </div>

        {/* Filters */}
        <div className="flex items-center space-x-1 bg-[#0b1624] p-0.5 rounded border border-borderTeal/40 text-[10px]">
          {['ALL', 'TOOL', 'LLM', 'HITL', 'SEAM'].map((f) => (
            <button
              key={f}
              onClick={() => {
                soundEngine.click();
                setFilter(f);
              }}
              className={`px-2 py-0.5 rounded transition-colors ${
                filter === f ? 'bg-[#5eead4] text-bg font-bold' : 'text-dimText hover:text-mutedText'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Streamed Event Log */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 text-xs">
        {filteredEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-dimText space-y-2">
            <Terminal className="w-8 h-8 opacity-40" />
            <p className="text-xs">Awaiting kernel trace events...</p>
          </div>
        ) : (
          filteredEvents.map((ev, index) => (
            <div
              key={`${ev.turnId}-${index}`}
              onClick={() => {
                soundEngine.click();
                onSelectEvent(ev);
              }}
              className="p-2 rounded bg-[#0b1624]/60 border border-borderTeal/30 hover:border-[#5eead4]/60 hover:bg-[#0b1624] cursor-pointer transition-all flex items-start justify-between group"
            >
              <div className="flex items-start space-x-2 overflow-hidden">
                <span className={`text-[10px] px-1.5 py-0.5 rounded border uppercase font-bold ${getSeamBadgeColor(ev.seam)}`}>
                  {ev.seam}
                </span>

                <div className="truncate">
                  <div className="flex items-center space-x-2 text-[11px] text-[#dbeaf0]">
                    <span className="font-semibold text-mutedText truncate">{ev.data?.tool ? String(ev.data.tool) : ev.data?.agent ? String(ev.data.agent) : ev.turnId.slice(0, 8)}</span>
                    {Boolean(ev.data?.preview) && (
                      <span className="text-dimText truncate max-w-[280px]">&gt; {String(ev.data?.preview)}</span>
                    )}
                  </div>
                  {Boolean(ev.data?.input) && (
                    <div className="text-[10px] text-dimText flex items-center space-x-1 mt-0.5">
                      <CornerDownRight className="w-3 h-3 text-dimText" />
                      <span className="truncate">{String(ev.data?.input)}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center space-x-3 text-[10px] text-dimText shrink-0">
                <span className="font-bold text-[#5eead4]">{ev.ms}ms</span>
                <span>{ev.timestamp}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
