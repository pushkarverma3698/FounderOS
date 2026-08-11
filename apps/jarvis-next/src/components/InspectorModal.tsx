import { useEffect, useState } from 'react';
import { X, Copy, Check, ShieldCheck } from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';

interface InspectorModalProps {
  title: string;
  data: Record<string, unknown> | null;
  onClose: () => void;
}

/** Serialise inspector payloads without choking on React component refs (icons). */
function serialise(data: Record<string, unknown>): string {
  return JSON.stringify(
    data,
    (_key, value) => (typeof value === 'function' ? '[component]' : value),
    2
  );
}

export function InspectorModal({ title, data, onClose }: InspectorModalProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!data) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data, onClose]);

  if (!data) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      className="fixed inset-0 z-[60] bg-void/85 backdrop-blur-md grid place-items-center p-6 rise-in"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="hud-panel ticks glow-accent w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-accent/15 shrink-0">
          <span className="value-heavy text-[11px] tracking-[0.18em] text-accent truncate">
            {title}
          </span>

          <span className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => {
                soundEngine.click();
                void navigator.clipboard?.writeText(serialise(data));
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              }}
              title="Copy JSON"
              className="p-1.5 text-chrome/40 hover:text-accent transition-colors"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-accent" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
            <button
              onClick={() => {
                soundEngine.click();
                onClose();
              }}
              title="Close (Esc)"
              className="p-1.5 text-chrome/40 hover:text-alarm transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </span>
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-b border-accent/8 shrink-0">
          <span className="label-micro">verified by ToolReceiptSchema</span>
          <span className="flex items-center gap-1.5 font-mono text-[9px] tracking-widest text-accent">
            <ShieldCheck className="w-3 h-3" />
            RECEIPT STAMPED
          </span>
        </div>

        <pre className="flex-1 min-h-0 overflow-auto p-4 font-mono font-light text-[11px] leading-relaxed text-accent/85 whitespace-pre-wrap break-all">
          {serialise(data)}
        </pre>
      </div>
    </div>
  );
}
