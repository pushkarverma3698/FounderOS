import { useState } from 'react';
import { soundEngine } from '../audio/soundEngine';
import type { TraceEventItem } from './TraceWaterfall';

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

/**
 * Live seam trace. Deliberately not draggable — Framer Motion v13 `dragConstraints`
 * ejected this panel out of its column on mount (measured translateX(-1006px)).
 */
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
    if (seam.includes('error') || seam.includes('blocked')) return 'text-alarm border-alarm/40';
    if (seam.includes('hitl')) return 'text-signal border-signal/40';
    return 'text-accent border-accent/35';
  };

  return (
    <div className="hud-panel ticks h-full flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-accent/12 shrink-0">
        <span className="flex items-center gap-2">
          <span className="w-1 h-3 bg-accent animate-breathe" />
          <span className="label-micro !text-chrome/70">Seam Trace</span>
        </span>

        <div className="flex items-center gap-0.5">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => {
                soundEngine.click();
                setFilter(f);
              }}
              className={`px-1.5 py-0.5 font-mono text-[9px] tracking-widest transition-colors ${
                filter === f
                  ? 'bg-accent text-void font-bold'
                  : 'text-chrome/35 hover:text-accent font-light'
              }`}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {visible.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-5 px-4 py-6">
            <span className="flex flex-col items-center gap-2">
              <span className="w-8 h-8 border border-accent/30 grid place-items-center">
                <span className="w-1.5 h-1.5 bg-accent rounded-full animate-breathe" />
              </span>
              <span className="label-micro text-center">awaiting kernel seam events</span>
            </span>

            <div className="w-full space-y-1.5">
              <span className="label-micro block !text-accent/70">Quick dispatch</span>
              {QUICK_COMMANDS.map((c) => (
                <button
                  key={c.label}
                  onClick={() => {
                    soundEngine.click();
                    onQuickCommand(c.prompt);
                  }}
                  className="w-full px-2.5 py-1.5 text-left font-mono font-light text-[10px] text-chrome/60 border border-accent/12 hover:border-accent/60 hover:text-accent hover:bg-accent/5 transition-all truncate"
                >
                  <span className="text-accent/50 mr-1.5">›</span>
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="divide-y divide-accent/8">
            {visible.map((ev, i) => (
              <button
                key={`${ev.turnId}-${i}`}
                type="button"
                onClick={() => {
                  soundEngine.click();
                  onSelectEvent(ev);
                }}
                className="w-full px-3 py-2 text-left slide-in hover:bg-accent/6 transition-colors group"
              >
                <span className="flex items-center justify-between gap-2">
                  <span
                    className={`font-mono text-[9px] font-medium tracking-wider px-1.5 py-0.5 border shrink-0 ${seamTone(
                      ev.seam
                    )}`}
                  >
                    {ev.seam}
                  </span>
                  <span className="font-mono font-light text-[9px] text-chrome/30 tabular-nums shrink-0">
                    {ev.ms}ms · {ev.timestamp}
                  </span>
                </span>

                <span className="block mt-1 font-mono font-light text-[10px] text-chrome/65 truncate">
                  {String(ev.data?.tool ?? ev.data?.agent ?? ev.turnId)}
                  {Boolean(ev.data?.input) && (
                    <span className="text-chrome/35"> — {String(ev.data?.input)}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
