import { useState } from 'react';
import { ShieldAlert, ShieldCheck, Check, X } from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';
import { voiceEngine } from '../audio/voiceEngine';

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

/**
 * The founder gate. This is the one place `signal` amber is allowed to dominate —
 * a pending approval is the single state that must interrupt the accent field.
 */
export function HitlTerminal({ pendingItems, onApprove, onReject }: HitlTerminalProps) {
  const [selectedId, setSelectedId] = useState('');

  if (pendingItems.length === 0) {
    return (
      <div className="hud-panel ticks h-full flex items-center gap-3 px-4">
        <ShieldCheck className="w-4 h-4 text-accent/70 shrink-0" />
        <span className="min-w-0">
          <span className="block value-heavy text-[12px] tracking-[0.14em] text-chrome/85">
            NO APPROVALS PENDING
          </span>
          <span className="block label-micro mt-0.5 truncate">
            side effects gated · idempotency enforced
          </span>
        </span>
      </div>
    );
  }

  const current = pendingItems.find((i) => i.id === selectedId) ?? pendingItems[0];

  return (
    <div className="hud-panel hud-panel-signal ticks h-full flex flex-col overflow-hidden">
      <div className="px-3 py-2 border-b border-signal/25 shrink-0">
        <span className="flex items-center gap-2">
          <ShieldAlert className="w-3.5 h-3.5 text-signal animate-breathe shrink-0" />
          <span className="value-heavy text-[11px] tracking-[0.18em] text-signal truncate">
            HITL GATE · {pendingItems.length} PENDING
          </span>
        </span>
        <span className="label-micro block mt-1 !text-signal/60 truncate">
          founder authorization required
        </span>
      </div>

      <div className="flex-1 flex min-h-0">
        {pendingItems.length > 1 && (
          <div className="w-40 shrink-0 border-r border-signal/15 overflow-y-auto">
            {pendingItems.map((item) => (
              <button
                key={item.id}
                onClick={() => {
                  soundEngine.click();
                  setSelectedId(item.id);
                }}
                className={`w-full px-2.5 py-2 text-left border-b border-signal/10 transition-colors ${
                  current.id === item.id ? 'bg-signal/12' : 'hover:bg-signal/6'
                }`}
              >
                <span className="block font-mono text-[10px] text-chrome/85 truncate">
                  {item.toolName}
                </span>
                <span className="block label-micro mt-0.5 !text-signal/60">{item.riskLevel}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 flex flex-col min-w-0 p-3 gap-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="value-heavy text-[13px] text-signal truncate">{current.toolName}</span>
            <span className="label-micro shrink-0">{current.requestedAt}</span>
          </div>

          <p className="font-mono font-light text-[10px] text-chrome/70 leading-relaxed">
            {current.description}
          </p>

          <pre className="flex-1 min-h-0 overflow-auto bg-void/70 border border-signal/15 p-2 font-mono text-[10px] font-light text-accent/85">
            {JSON.stringify(current.payload, null, 2)}
          </pre>

          <div className="flex items-center justify-end gap-2 shrink-0">
            <button
              onClick={() => {
                soundEngine.warning();
                voiceEngine.speak(`Action rejected for tool ${current.toolName}`);
                onReject(current.id);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-alarm/50 text-alarm font-mono text-[10px] font-medium tracking-[0.14em] hover:bg-alarm/12 transition-colors"
            >
              <X className="w-3 h-3" strokeWidth={3} />
              REJECT
            </button>
            <button
              onClick={() => {
                soundEngine.success();
                voiceEngine.speak(`Action approved for tool ${current.toolName}`);
                onApprove(current.id);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-signal text-void font-mono text-[10px] font-bold tracking-[0.14em] hover:brightness-110 transition-all"
            >
              <Check className="w-3 h-3" strokeWidth={3} />
              APPROVE
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
