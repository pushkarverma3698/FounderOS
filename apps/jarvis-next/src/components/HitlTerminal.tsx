import { useState } from 'react';
import { ShieldAlert, ShieldCheck, Check, X } from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';
import { voiceEngine } from '../audio/voiceEngine';
import { SpotlightCard } from './magic/SpotlightCard';
import { MagneticButton } from './magic/MagneticButton';
import { motion, AnimatePresence } from 'framer-motion';

export interface HitlItem {
  id: string;
  toolName: string;
  payload: Record<string, unknown>;
  riskLevel: 'HIGH' | 'CRITICAL' | 'MEDIUM';
  description: string;
  requestedAt: string;
}

interface HitlTerminalProps {
  pendingItems: HitlItem[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}

export function HitlTerminal({ pendingItems, onApprove, onReject }: HitlTerminalProps) {
  const [selectedId, setSelectedId] = useState('');

  if (pendingItems.length === 0) {
    return (
      <SpotlightCard className="h-full flex flex-col justify-center gap-3 p-6 border-white/5 bg-white/5">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-5 h-5 text-accent/70 shrink-0" />
          <span className="min-w-0">
            <span className="block font-sans font-semibold text-[13px] tracking-[0.14em] text-white">
              NO APPROVALS PENDING
            </span>
            <span className="block label-micro mt-1 truncate">
              side effects gated · idempotency enforced
            </span>
          </span>
        </div>
      </SpotlightCard>
    );
  }

  const current = pendingItems.find((i) => i.id === selectedId) ?? pendingItems[0];

  return (
    <SpotlightCard 
      spotlightColor="rgba(255, 176, 32, 0.2)"
      className="hud-panel-signal h-full flex flex-col p-0 overflow-hidden"
    >
      <div className="px-4 py-3 border-b border-signal/20 bg-signal/5 shrink-0">
        <span className="flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-signal animate-breathe shrink-0" />
          <span className="font-sans font-semibold text-[12px] tracking-[0.18em] text-signal truncate">
            HITL GATE · {pendingItems.length} PENDING
          </span>
        </span>
        <span className="label-micro block mt-1.5 !text-signal/70 truncate">
          founder authorization required
        </span>
      </div>

      <div className="flex-1 flex min-h-0 relative">
        {pendingItems.length > 1 && (
          <div className="w-44 shrink-0 border-r border-white/5 overflow-y-auto bg-black/20">
            {pendingItems.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  soundEngine.click();
                  setSelectedId(item.id);
                }}
                className={`w-full px-4 py-3 text-left border-b border-white/5 transition-colors relative ${
                  current.id === item.id ? 'bg-signal/10' : 'hover:bg-white/5'
                }`}
              >
                {current.id === item.id && (
                  <motion.div 
                    layoutId="hitl-active" 
                    className="absolute inset-y-0 left-0 w-1 bg-signal"
                  />
                )}
                <span className="block font-mono text-[11px] text-white/90 truncate">
                  {item.toolName}
                </span>
                <span className="block label-micro mt-1 !text-signal/70">{item.riskLevel}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 flex flex-col min-w-0 p-4 gap-3 bg-black/10">
          <AnimatePresence mode="wait">
            <motion.div 
              key={current.id}
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -5 }}
              className="flex-1 flex flex-col gap-3 min-h-0"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-sans font-semibold text-[15px] text-signal truncate">{current.toolName}</span>
                <span className="label-micro shrink-0">{current.requestedAt}</span>
              </div>

              <p className="font-mono text-[11px] text-white/70 leading-relaxed">
                {current.description}
              </p>

              <pre className="flex-1 min-h-0 overflow-auto rounded-lg bg-black/40 border border-white/10 p-3 font-mono text-[11px] text-accent/90 shadow-inner">
                {JSON.stringify(current.payload, null, 2)}
              </pre>
            </motion.div>
          </AnimatePresence>

          <div className="flex items-center justify-end gap-3 shrink-0 pt-2 border-t border-white/5">
            <MagneticButton
              onClick={() => {
                soundEngine.warning();
                voiceEngine.speak(`Action rejected for tool ${current.toolName}`);
                onReject(current.id);
              }}
              className="flex items-center gap-2 px-4 py-2 border-none bg-alarm/10 text-alarm font-sans text-[11px] font-semibold tracking-wider hover:bg-alarm/20"
            >
              <X className="w-3.5 h-3.5" strokeWidth={3} />
              REJECT
            </MagneticButton>
            <MagneticButton
              onClick={() => {
                soundEngine.success();
                voiceEngine.speak(`Action approved for tool ${current.toolName}`);
                onApprove(current.id);
              }}
              className="flex items-center gap-2 px-4 py-2 border-none bg-signal text-black font-sans text-[11px] font-bold tracking-wider shadow-[0_0_20px_rgba(255,176,32,0.4)]"
            >
              <Check className="w-3.5 h-3.5" strokeWidth={3} />
              APPROVE
            </MagneticButton>
          </div>
        </div>
      </div>
    </SpotlightCard>
  );
}
