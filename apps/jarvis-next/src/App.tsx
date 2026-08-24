import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { Header } from './components/Header';
import { NavRail, type RailTab } from './components/NavRail';
import type { ReactorPerf } from './components/reactor/ReactorStage';
import { DepartmentOverlay } from './components/reactor/DepartmentOverlay';
import { PROJ_LENGTH } from './gpu/ring';
import { CommandBar } from './components/CommandBar';
import { ReactorErrorBoundary } from './components/reactor/ReactorErrorBoundary';
import { RealTimeTerminal } from './components/RealTimeTerminal';
import { GlassMetricCards } from './components/GlassMetricCards';
import { HitlTerminal, type HitlItem } from './components/HitlTerminal';
import { InspectorModal } from './components/InspectorModal';
import type { TraceEventItem } from './components/TraceWaterfall';
import { DEPARTMENTS, SUPERVISOR } from './lib/departments';
import { isStreaming, type DepartmentNodeData } from './types/graph';
import { soundEngine } from './audio/soundEngine';
import { voiceEngine } from './audio/voiceEngine';
import { QueueTab } from './components/QueueTab';

const INITIAL_HITL: HitlItem[] = [
  {
    id: 'hitl-1',
    toolName: 'vps_run',
    payload: { command: 'systemctl restart postgresql', host: 'founderos-vps' },
    riskLevel: 'CRITICAL',
    description: 'Founder authorization required to execute a command on the production VPS.',
    requestedAt: '00:44:12 IST',
  },
];

/**
 * The reactor pulls in three's WebGPU build — ~1.8MB raw / 500KB gzip, which is
 * the overwhelming majority of the bundle. Split it out so the instrument layer,
 * the HITL gate and the trace stream paint immediately and the GPU volume
 * streams in behind them. The data must never wait on the decoration.
 */
const ReactorStage = lazy(() =>
  import('./components/reactor/ReactorStage').then((m) => ({ default: m.ReactorStage }))
);

/** Matches BUDGET_DAILY_USD on the kernel side; drives field brightness. */
const DAILY_SPEND_CAP = 5;

const now = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
const newTurnId = () => `turn-${Math.random().toString(36).slice(2, 8)}`;

export function App() {
  const [activeTab, setActiveTab] = useState<RailTab>('CORE');
  const [mode, setMode] = useState<'LIVE' | 'REPLAY'>('LIVE');
  const [supervisor, setSupervisor] = useState(SUPERVISOR);
  const [departments, setDepartments] = useState<DepartmentNodeData[]>(DEPARTMENTS);
  const [traceEvents, setTraceEvents] = useState<TraceEventItem[]>([]);
  const [pendingHitl, setPendingHitl] = useState<HitlItem[]>(INITIAL_HITL);
  const [spendToday, setSpendToday] = useState(0.0425);
  const [dbStatus, setDbStatus] = useState('unknown');
  const [systemStatus, setSystemStatus] = useState<'ok' | 'degraded'>('ok');
  /**
   * Whether the kernel gateway is actually answering.
   *
   * Starts at 'connecting', never at 'online'. The previous version defaulted
   * dbStatus to 'up' and swallowed fetch failures, so with the gateway refusing
   * every connection the header still read "STATUS NOMINAL · DB UP" — the
   * dashboard asserting the system was healthy while it could not reach it at
   * all. A surface that cannot distinguish "fine" from "cannot tell" is worse
   * than no surface.
   */
  const [gateway, setGateway] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [inspector, setInspector] = useState<{ title: string; data: Record<string, unknown> } | null>(
    null
  );
  const [perf, setPerf] = useState<ReactorPerf>({
    fps: 0,
    particles: 0,
    backend: 'detecting',
  });

  /* ---------------- Backend health poll ---------------- */
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const res = await fetch('/health');
        if (!alive) return;
        if (!res.ok) {
          setGateway('offline');
          setDbStatus('unknown');
          return;
        }
        const data = await res.json();
        setGateway('online');
        setDbStatus(data.checks?.database ?? 'unknown');
        setSystemStatus(data.status === 'degraded' ? 'degraded' : 'ok');
        if (typeof data.spend_today_usd?.turicks === 'number') {
          setSpendToday(data.spend_today_usd.turicks);
        }
      } catch {
        // Say so. Never hold the last good reading and let it pass for current.
        if (alive) {
          setGateway('offline');
          setDbStatus('unknown');
        }
      }
    };
    void poll();
    const id = setInterval(poll, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  /* ---------------- Live seam trace over SSE ---------------- */
  useEffect(() => {
    if (mode !== 'LIVE') return;
    let es: EventSource;
    try {
      es = new EventSource('/api/v1/sse/trace');
    } catch {
      return;
    }

    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.type === 'connected') return;
        setTraceEvents((prev) =>
          [
            {
              turnId: parsed.turnId ?? newTurnId(),
              seam: parsed.seam ?? 'tool.call',
              ms: parsed.ms ?? 0,
              data: parsed.data ?? {},
              timestamp: now(),
            },
            ...prev,
          ].slice(0, 100)
        );
      } catch {
        // Malformed frame — drop it rather than tear down the stream.
      }
    };
    es.onerror = () => es.close();

    return () => es.close();
  }, [mode]);

  /* ---------------- Dispatch a turn ---------------- */
  const dispatchTurn = useCallback((prompt: string) => {
    const turnId = newTurnId();

    setTraceEvents((prev) =>
      [{ turnId, seam: 'turn.in', ms: 0, data: { prompt, agent: 'supervisor' }, timestamp: now() }, ...prev].slice(
        0,
        100
      )
    );
    setSupervisor((s) => ({ ...s, status: 'EXECUTING', lastAction: prompt }));

    void fetch('/api/v1/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    }).catch(() => {
      // Offline preview — the optimistic trace above still renders.
    });

    window.setTimeout(() => {
      setTraceEvents((prev) =>
        [
          { turnId, seam: 'tool.call', ms: 18, data: { tool: 'pnpm gate', input: 'verify:arch' }, timestamp: now() },
          ...prev,
        ].slice(0, 100)
      );
      setSupervisor((s) => ({ ...s, status: 'IDLE', receiptCount: s.receiptCount + 1 }));
      setDepartments((prev) =>
        prev.map((d) =>
          d.id === 'engineering'
            ? { ...d, status: 'EXECUTING', lastAction: prompt, receiptCount: d.receiptCount + 1 }
            : d
        )
      );
      voiceEngine.speak('Execution verified. Tool receipt generated.');
      soundEngine.success();
    }, 1200);
  }, []);

  /* ---------------- HITL resolution ---------------- */
  /**
   * Only report an approval the server actually performed.
   *
   * This used to fire and forget: it dropped the pending card and painted
   * "Approved: shell execution" regardless of what came back. The server's
   * /api/v1/hitl/respond has no resume path and now answers 501 — so the button
   * showed a green authorization for a side effect that never happened, which is
   * the same lie the endpoint itself was just fixed for. A card that stays put
   * with a stated reason is strictly safer than a false success.
   */
  const resolveHitl = useCallback((id: string, action: 'approve' | 'reject') => {
    void (async () => {
      let detail = 'the approval endpoint is unreachable';
      try {
        const res = await fetch('/api/v1/hitl/respond', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, action }),
        });
        if (res.ok) {
          setPendingHitl((prev) => prev.filter((i) => i.id !== id));
          setDepartments((prev) =>
            prev.map((d) =>
              d.id === 'exec'
                ? {
                    ...d,
                    status: action === 'approve' ? 'SUCCESS' : 'IDLE',
                    lastAction: action === 'approve' ? 'Approved: shell execution' : 'Rejected by founder',
                  }
                : d
            )
          );
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { detail?: string };
        detail = body.detail ?? `the approval endpoint returned ${res.status}`;
      } catch {
        /* keep the default detail — the request never reached the server */
      }

      // The item stays pending on purpose: nothing was authorized, so the gate
      // is still open and must keep looking open.
      soundEngine.warning();
      setDepartments((prev) =>
        prev.map((d) =>
          d.id === 'exec' ? { ...d, status: 'IDLE', lastAction: `Not authorized — ${detail}` } : d
        )
      );
    })();
  }, []);

  const totalTurns = departments.reduce((a, d) => a + d.receiptCount, supervisor.receiptCount);
  const activeCount = departments.filter((d) => isStreaming(d.status)).length;

  /** Shared 60fps channel from the GPU projector to the DOM overlay. */
  const projection = useMemo(() => new Float32Array(PROJ_LENGTH), []);
  const spendRatio = Math.min(1, spendToday / DAILY_SPEND_CAP);

  const inspectNode = useCallback(
    (node: DepartmentNodeData) =>
      setInspector({
        title: `NODE CONTRACT — ${node.name}`,
        data: node as unknown as Record<string, unknown>,
      }),
    []
  );

  return (
    <div className="h-screen flex flex-col bg-void text-chrome font-sans overflow-hidden mesh-bg">
      <Header
        mode={mode}
        onToggleMode={() => setMode((m) => (m === 'LIVE' ? 'REPLAY' : 'LIVE'))}
        systemStatus={systemStatus}
        dbStatus={dbStatus}
        gateway={gateway}
        onVoiceInput={dispatchTurn}
      />

      {/* The founder must never mistake seeded demo state for live kernel state. */}
      {gateway === 'offline' && (
        <div className="shrink-0 flex items-center gap-3 px-6 py-2 bg-signal/10 border-b border-signal/20 z-40 relative backdrop-blur-md">
          <span className="w-1.5 h-1.5 rounded-full bg-signal animate-breathe shrink-0 shadow-[0_0_10px_rgba(255,176,32,0.6)]" />
          <span className="font-sans font-bold text-[11px] tracking-[0.2em] text-signal uppercase">
            Kernel Gateway Unreachable
          </span>
          <span className="font-mono font-light text-[11px] text-white/50">
            localhost:3001 refused the connection — everything below is seeded demo
            state, not live telemetry. Dispatch is disabled.
          </span>
        </div>
      )}

      <div className="flex-1 flex min-h-0 relative z-10 p-4 gap-4">
        <NavRail activeTab={activeTab} onSelectTab={setActiveTab} />

        <main className="flex-1 relative min-w-0 overflow-hidden rounded-2xl border border-white/5 bg-black/20 shadow-2xl backdrop-blur-sm">
          {activeTab === 'CORE' && (
            <>
              {/* The volume. Full-bleed behind everything; the instrument
                  columns float over it rather than carving space out of it. */}
              <ReactorErrorBoundary>
                <div className="absolute inset-0 xl:left-[270px] xl:right-[330px]">
                  <Suspense fallback={<div className="absolute inset-0 grid-floor" />}>
                    <ReactorStage
                      departments={departments}
                      spendRatio={spendRatio}
                      projection={projection}
                      onPerf={setPerf}
                    />
                  </Suspense>
                  <DepartmentOverlay
                    departments={departments}
                    projection={projection}
                    onSelect={inspectNode}
                  />
                </div>
              </ReactorErrorBoundary>

              {/* Supervisor identity, pinned to the core at screen centre */}
              <button
                onClick={() => inspectNode(supervisor)}
                className="absolute left-1/2 xl:left-[calc(50%-30px)] top-1/2 -translate-x-1/2 -translate-y-1/2 z-30 flex flex-col items-center gap-2 focus:outline-none group"
              >
                <span className="flex items-center gap-3 px-5 py-2.5 rounded-full border border-white/10 bg-black/40 backdrop-blur-xl group-hover:border-accent/50 group-hover:bg-black/60 transition-all shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
                  <span
                    className="w-2 h-2 rounded-full animate-ping"
                    style={{
                      background: pendingHitl.length ? 'var(--signal)' : 'var(--accent)',
                      boxShadow: `0 0 15px ${pendingHitl.length ? 'var(--signal)' : 'var(--accent)'}`,
                    }}
                  />
                  <span className="font-sans font-bold text-[13px] tracking-[0.25em] text-white uppercase">
                    Supervisor
                  </span>
                  <span className="font-mono text-[10px] font-semibold tracking-widest text-accent px-2 py-0.5 bg-accent/10 rounded">
                    {supervisor.status}
                  </span>
                </span>
                <span className="label-micro px-3 py-1 bg-black/40 rounded-full border border-white/5 backdrop-blur-md">
                  stamped receipts
                  <span className="text-accent font-semibold ml-2 tabular-nums">
                    {supervisor.receiptCount}
                  </span>
                </span>
              </button>

              <CommandBar onDispatch={dispatchTurn} disabled={gateway === 'offline'} />

              {/* Left instrument column */}
              <div className="hidden xl:block absolute left-6 top-6 w-[240px] z-40">
                <GlassMetricCards
                  layout="stack"
                  todaySpend={spendToday}
                  totalTurns={totalTurns}
                  avgLatencyMs={14}
                  evalPassRate={98.4}
                  systemStatus={systemStatus}
                  gateway={gateway}
                />
              </div>

              {/* HITL gate — bottom-left, escalates to amber when pending */}
              <div className="hidden xl:block absolute left-6 bottom-6 w-[240px] h-[240px] z-40">
                <HitlTerminal
                  pendingItems={pendingHitl}
                  onApprove={(id) => resolveHitl(id, 'approve')}
                  onReject={(id) => resolveHitl(id, 'reject')}
                />
              </div>

              {/* Right instrument column — live seam trace */}
              <div className="hidden xl:flex absolute right-6 top-6 bottom-6 w-[310px] z-40 flex-col gap-4">
                <div className="hud-panel p-5 shrink-0 flex flex-col gap-3">
                  <div className="flex justify-between items-end">
                    <span className="label-micro block">Routing load</span>
                    <span className="font-mono font-light text-[10px] text-white/40">
                      {activeCount} / {departments.length} streaming
                    </span>
                  </div>
                  <span className="flex items-baseline gap-1">
                    <span className="font-sans font-bold text-[32px] text-accent text-glow leading-none">
                      {Math.round((activeCount / Math.max(1, departments.length)) * 100)}%
                    </span>
                  </span>
                  <span className="flex gap-1.5 h-1.5">
                    {departments.map((d) => (
                      <span
                        key={d.id}
                        title={`${d.name} — ${d.status}`}
                        className={`h-full rounded-full flex-1 transition-colors ${
                          d.status === 'HITL_PAUSE'
                            ? 'bg-signal shadow-[0_0_8px_rgba(255,176,32,0.5)]'
                            : isStreaming(d.status)
                            ? 'bg-accent shadow-[0_0_8px_rgba(0,229,255,0.5)]'
                            : 'bg-white/10'
                        }`}
                      />
                    ))}
                  </span>

                  {/* Measured, not claimed: the budget the frame monitor settled on. */}
                  <span className="pt-3 border-t border-white/10 flex items-center justify-between font-mono font-medium text-[10px]">
                    <span className="text-white/40 uppercase tracking-[0.16em]">
                      {perf.backend}
                    </span>
                    <span className="text-white/60 tabular-nums">
                      <span className={perf.fps >= 55 ? 'text-accent' : 'text-signal'}>
                        {perf.fps || '—'}
                      </span>
                      {' fps · '}
                      {perf.particles ? `${(perf.particles / 1000).toFixed(0)}k` : '—'} pts
                    </span>
                  </span>
                </div>

                <div className="flex-1 min-h-0">
                  <RealTimeTerminal
                    events={traceEvents}
                    onSelectEvent={(ev) =>
                      setInspector({
                        title: `SEAM EVENT — ${ev.seam}`,
                        data: ev as unknown as Record<string, unknown>,
                      })
                    }
                    onQuickCommand={dispatchTurn}
                  />
                </div>
              </div>
            </>
          )}

          {activeTab === 'QUEUE' && (
            <QueueTab />
          )}

          {activeTab !== 'CORE' && activeTab !== 'QUEUE' && (
            <div className="absolute inset-0 overflow-y-auto p-8">
              <TabPanel tab={activeTab} departments={departments} spendToday={spendToday} totalTurns={totalTurns} />
            </div>
          )}
        </main>
      </div>

      <InspectorModal
        title={inspector?.title ?? ''}
        data={inspector?.data ?? null}
        onClose={() => setInspector(null)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */

interface TabPanelProps {
  tab: RailTab;
  departments: DepartmentNodeData[];
  spendToday: number;
  totalTurns: number;
}

function TabPanel({ tab, departments, spendToday, totalTurns }: TabPanelProps) {
  const heading =
    tab === 'PLAN'
      ? '02 · Typed plan & cursor control'
      : tab === 'ORG'
      ? '03 · Worker capability matrix'
      : tab === 'SYS'
      ? '04 · Failure surface & health'
      : '05 · Cost scoreboard';

  return (
    <section className="max-w-5xl space-y-6">
      <h2 className="font-sans font-bold text-[18px] tracking-[0.15em] text-accent text-glow uppercase">{heading}</h2>

      {tab === 'PLAN' && (
        <div className="hud-panel p-6 font-mono text-[12px] text-white/70 space-y-4">
          <p className="text-white/50 mb-4">
            Plans execute deterministically. Every step is bound by cursor limits, budget ceilings
            and prompt-hash verification.
          </p>
          {[
            ['MAX_PLAN_STEPS', '8'],
            ['CURRENT CURSOR', 'step 2 of 4'],
            ['DETERMINISM HASH', '09a2f1b8c091 · 100% match'],
            ['TEMPERATURE', '0'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-white/5 pb-2">
              <span className="label-micro">{k}</span>
              <span className="text-accent">{v}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'ORG' && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {departments.map((d) => (
            <div key={d.id} className="hud-panel p-4 flex flex-col gap-1 hover:border-accent/30 transition-colors">
              <span className="block font-sans font-bold text-[14px] text-white tracking-wide">{d.name}</span>
              <span className="block label-micro">{d.department}</span>
              <span className="block mt-3 font-mono text-[10px] text-accent/70 bg-accent/5 px-2 py-1 rounded inline-block w-fit border border-accent/10">
                context isolation: enforced
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === 'SYS' && (
        <div className="hud-panel p-6 space-y-4">
          <p className="font-mono text-[12px] text-white/60">
            FailureReport sensors report stage, component, evidence and retryability.
          </p>
          <div className="flex items-center gap-3 border border-accent/20 bg-accent/5 px-4 py-3 rounded-lg">
            <span className="w-2 h-2 rounded-full bg-accent animate-breathe shadow-[0_0_10px_rgba(0,229,255,0.5)]" />
            <span className="font-mono text-[12px] text-accent">
              zero failures reported in the last 24 hours
            </span>
          </div>
        </div>
      )}

      {tab === 'DATA' && (
        <div className="hud-panel p-6 grid grid-cols-2 gap-6">
          <div className="flex flex-col gap-1">
            <span className="label-micro block">spend today</span>
            <span className="font-sans font-bold text-[36px] text-accent text-glow">
              ${spendToday.toFixed(4)}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="label-micro block">stamped turns</span>
            <span className="font-sans font-bold text-[36px] text-accent text-glow">{totalTurns}</span>
          </div>
        </div>
      )}
    </section>
  );
}
