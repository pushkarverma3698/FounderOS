import type { CSSProperties } from 'react';
import { SpotlightCard } from './magic/SpotlightCard';
import { AnimatedCounter } from './magic/AnimatedCounter';

interface GlassMetricCardsProps {
  todaySpend: number;
  totalTurns: number;
  avgLatencyMs: number;
  evalPassRate: number;
  systemStatus: string;
  gateway: 'connecting' | 'online' | 'offline';
  layout?: 'row' | 'stack';
}

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

  const readouts = offline
    ? [
        { label: 'Kernel', value: 'NO SIGNAL', sub: 'gateway unreachable', alert: true, isNumber: false },
        { label: 'Spend today', value: todaySpend, sub: 'last seen $' + todaySpend.toFixed(4), alert: false, isNumber: true, prefix: '$', decimals: 4 },
        { label: 'Stamped turns', value: totalTurns, sub: 'last seen ' + totalTurns, alert: false, isNumber: true },
        { label: 'Kernel latency', value: '—', sub: 'no response', alert: false, isNumber: false },
      ]
    : [
        {
          label: 'Kernel',
          value: gateway === 'connecting' ? 'CONNECTING' : degraded ? 'DEGRADED' : 'NOMINAL',
          sub: 'postgres · checkpointer',
          alert: degraded,
          isNumber: false
        },
        {
          label: 'Spend today',
          value: todaySpend,
          sub: 'cap $5.0000 / day',
          alert: todaySpend > 5,
          isNumber: true,
          prefix: '$',
          decimals: 4
        },
        {
          label: 'Stamped turns',
          value: totalTurns,
          sub: `$${(todaySpend / (totalTurns || 1)).toFixed(4)} avg`,
          alert: false,
          isNumber: true
        },
        {
          label: 'Kernel latency',
          value: avgLatencyMs,
          sub: `eval pass ${evalPassRate.toFixed(1)}%`,
          alert: avgLatencyMs > 500,
          isNumber: true,
          suffix: 'ms'
        },
      ];

  return (
    <div className={layout === 'row' ? 'flex items-stretch gap-4' : 'flex flex-col gap-4'}>
      {readouts.map((r, i) => (
        <SpotlightCard
          key={r.label}
          spotlightColor={r.alert ? "rgba(255, 176, 32, 0.25)" : "rgba(0, 229, 255, 0.15)"}
          className={`${layout === 'row' ? 'flex-1' : 'w-full'} ${r.alert ? 'hud-panel-signal' : 'hud-panel'}`}
        >
          <span className="label-micro block">{r.label}</span>
          <span
            className={`block value-heavy text-[24px] leading-tight mt-1 ${
              r.alert ? 'text-signal text-glow-signal' : 'text-accent text-glow'
            }`}
          >
            {r.isNumber ? (
              <span className="flex items-baseline">
                {r.prefix && <span>{r.prefix}</span>}
                <AnimatedCounter value={r.value as number} decimals={r.decimals} />
                {r.suffix && <span>{r.suffix}</span>}
              </span>
            ) : (
              r.value
            )}
          </span>
          <span className="block font-mono font-medium text-[11px] text-chrome/50 mt-1 truncate">
            {r.sub}
          </span>
        </SpotlightCard>
      ))}
    </div>
  );
}
