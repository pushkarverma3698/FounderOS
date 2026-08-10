import type { CSSProperties } from 'react';

interface GlassMetricCardsProps {
  todaySpend: number;
  totalTurns: number;
  avgLatencyMs: number;
  evalPassRate: number;
  systemStatus: string;
  /** When the gateway is unreachable these numbers are stale — say so. */
  gateway: 'connecting' | 'online' | 'offline';
  /** 'row' floats the readouts horizontally; 'stack' pins them to an edge column. */
  layout?: 'row' | 'stack';
}

/**
 * Instrument readouts. Every value uses the single accent — the only colour
 * change is `signal`, and only when the kernel is genuinely degraded.
 */
export function GlassMetricCards({
  todaySpend,
  totalTurns,
  avgLatencyMs,
  evalPassRate,
  systemStatus,
  gateway,
  layout = 'row',
}: GlassMetricCardsProps) {
  const degraded = systemStatus !== 'ok';
  const offline = gateway === 'offline';

  // With the gateway down every figure here is a cached guess. Showing "NOMINAL"
  // next to a header that reads UNREACHABLE is the same defect as the header bug,
  // one layer down — so these read as stale rather than current.
  const readouts = offline
    ? [
        { label: 'Kernel', value: 'NO SIGNAL', sub: 'gateway unreachable', alert: true },
        { label: 'Spend today', value: '—', sub: 'last seen $' + todaySpend.toFixed(4), alert: false },
        { label: 'Stamped turns', value: '—', sub: 'last seen ' + totalTurns, alert: false },
        { label: 'Kernel latency', value: '—', sub: 'no response', alert: false },
      ]
    : [
        {
          label: 'Kernel',
          value: gateway === 'connecting' ? 'CONNECTING' : degraded ? 'DEGRADED' : 'NOMINAL',
          sub: 'postgres · checkpointer',
          alert: degraded,
        },
        {
          label: 'Spend today',
          value: `$${todaySpend.toFixed(4)}`,
          sub: 'cap $5.0000 / day',
          alert: todaySpend > 5,
        },
        {
          label: 'Stamped turns',
          value: totalTurns.toString(),
          sub: `$${(todaySpend / (totalTurns || 1)).toFixed(4)} avg`,
          alert: false,
        },
        {
          label: 'Kernel latency',
          value: `${avgLatencyMs}ms`,
          sub: `eval pass ${evalPassRate.toFixed(1)}%`,
          alert: avgLatencyMs > 500,
        },
      ];

  return (
    <div className={layout === 'row' ? 'flex items-stretch gap-2' : 'flex flex-col gap-2'}>
      {readouts.map((r, i) => (
        <div
          key={r.label}
          style={{ '--d': `${i * 55}ms` } as CSSProperties}
          className={`hud-panel ticks rise-in px-3 py-2 ${layout === 'row' ? 'flex-1' : 'w-full'} ${
            r.alert ? 'hud-panel-signal' : ''
          }`}
        >
          <span className="label-micro block">{r.label}</span>
          <span
            className={`block value-heavy text-[20px] leading-tight mt-0.5 ${
              r.alert ? 'text-signal text-glow-signal' : 'text-accent text-glow'
            }`}
          >
            {r.value}
          </span>
          <span className="block font-mono font-light text-[9px] text-chrome/35 mt-0.5 truncate">
            {r.sub}
          </span>
        </div>
      ))}
    </div>
  );
}
