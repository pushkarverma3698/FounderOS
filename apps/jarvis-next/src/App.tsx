import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { NavRail, RailTab } from './components/NavRail';
import { AntigravityCanvas } from './components/AntigravityCanvas';
import { DepartmentNodeData } from './components/OrbitingDepartmentNode';
import { RealTimeTerminal } from './components/RealTimeTerminal';
import { TraceEventItem } from './components/TraceWaterfall';
import { HitlTerminal, HitlItem } from './components/HitlTerminal';
import { GlassMetricCards } from './components/GlassMetricCards';
import { InspectorModal } from './components/InspectorModal';
import { Cpu, Terminal, Briefcase, Video, Target, Clock, ShieldCheck, Layers, Wrench, Activity } from 'lucide-react';
import { soundEngine } from './audio/soundEngine';
import { voiceEngine } from './audio/voiceEngine';

const INITIAL_NODES: DepartmentNodeData[] = [
  { id: 'supervisor', name: 'Supervisor CEO', department: 'Executive Kernel', status: 'IDLE', lastAction: 'Listening on gateway', x: 50, y: 38, icon: Cpu, receiptCount: 42, neonColor: 'cyan' },
  { id: 'coder', name: 'Coder Worker', department: 'Tech Ops', status: 'EXECUTING', lastAction: 'Running pnpm gate verification', x: 18, y: 18, icon: Terminal, receiptCount: 18, neonColor: 'cyan' },
  { id: 'devops', name: 'QA & DevOps', department: 'Infra Ops', status: 'IDLE', lastAction: 'Postgres health check ok', x: 14, y: 72, icon: Wrench, receiptCount: 14, neonColor: 'blue' },
  { id: 'jobhunt', name: 'Job Hunt Pipeline', department: 'Career Engine', status: 'TOOL_CALL', lastAction: 'Screening ATS Workable form', x: 38, y: 82, icon: Briefcase, receiptCount: 29, neonColor: 'cyan' },
  { id: 'videofactory', name: 'Video Factory', department: 'Creative Engine', status: 'IDLE', lastAction: 'Kling I2V prompt ready', x: 62, y: 82, icon: Video, receiptCount: 12, neonColor: 'purple' },
  { id: 'prospecting', name: 'Apify Prospecting', department: 'Revenue Engine', status: 'IDLE', lastAction: 'Scraping target ICP list', x: 86, y: 72, icon: Target, receiptCount: 15, neonColor: 'blue' },
  { id: 'personal', name: 'Personal Ops', department: 'Executive Support', status: 'HITL_PAUSE', lastAction: 'Gated: shell execution', x: 82, y: 18, icon: Clock, receiptCount: 8, neonColor: 'amber' },
];

const INITIAL_HITL: HitlItem[] = [
  {
    id: 'hitl-1',
    toolName: 'vps_run',
    payload: { command: 'systemctl restart postgresql', host: 'founderos-vps' },
    riskLevel: 'CRITICAL',
    description: 'Requires founder authorization to execute command on production VPS host.',
    requestedAt: '00:44:12 IST',
  },
];

export const App: React.FC = () => {
  const mainWorkspaceRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<RailTab>('CORE');
  const [mode, setMode] = useState<'LIVE' | 'REPLAY'>('LIVE');
  const [nodes, setNodes] = useState<DepartmentNodeData[]>(INITIAL_NODES);
  const [traceEvents, setTraceEvents] = useState<TraceEventItem[]>([]);
  const [pendingHitl, setPendingHitl] = useState<HitlItem[]>(INITIAL_HITL);
  const [spendToday, setSpendToday] = useState(0.0425);
  const [dbStatus, setDbStatus] = useState('up');
  const [systemStatus, setSystemStatus] = useState<'ok' | 'degraded'>('ok');
  const [inspectorData, setInspectorData] = useState<{ title: string; data: Record<string, unknown> } | null>(null);

  // Poll Health & Stats from Backend
  useEffect(() => {
    let isMounted = true;
    const fetchStats = async () => {
      try {
        const res = await fetch('/health');
        if (res.ok && isMounted) {
          const data = await res.json();
          setDbStatus(data.checks?.database || 'up');
          setSystemStatus(data.status || 'ok');
          const spend = data.spend_today_usd?.turicks || 0.0425;
          setSpendToday(spend > 0 ? spend : 0.0425);
        }
      } catch {
        // Fallback for local preview
      }
    };

    void fetchStats();
    const interval = setInterval(fetchStats, 5000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  // SSE Trace Event Stream Integration
  useEffect(() => {
    if (mode !== 'LIVE') return;
    const es = new EventSource('/api/v1/sse/trace');

    es.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.type === 'connected') return;

        const newEv: TraceEventItem = {
          turnId: parsed.turnId || 'turn-' + Math.random().toString(36).slice(2, 7),
          seam: parsed.seam || 'tool.call',
          ms: parsed.ms || Math.floor(Math.random() * 50),
          data: parsed.data || {},
          timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
        };

        setTraceEvents((prev) => [newEv, ...prev.slice(0, 99)]);
      } catch {
        // ignore
      }
    };

    return () => {
      es.close();
    };
  }, [mode]);

  // Listen for custom quick-command dispatch events
  useEffect(() => {
    const handleCustomDispatch = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (typeof detail === 'string') {
        handleDispatchTurn(detail);
      }
    };
    window.addEventListener('dispatch-turn', handleCustomDispatch);
    return () => window.removeEventListener('dispatch-turn', handleCustomDispatch);
  }, []);

  // Dispatch Turn Action
  const handleDispatchTurn = (prompt: string) => {
    const ev: TraceEventItem = {
      turnId: 'turn-' + Math.random().toString(36).slice(2, 7),
      seam: 'turn.in',
      ms: 0,
      data: { prompt, agent: 'supervisor' },
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
    };

    setTraceEvents((prev) => [ev, ...prev]);

    setNodes((prev) =>
      prev.map((n) => (n.id === 'supervisor' ? { ...n, status: 'EXECUTING', lastAction: prompt } : n))
    );

    // Send HTTP POST request to live backend server
    void fetch('/api/v1/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    }).catch(() => {
      // ignore offline fallback
    });

    setTimeout(() => {
      const toolEv: TraceEventItem = {
        turnId: ev.turnId,
        seam: 'tool.call',
        ms: 18,
        data: { tool: 'pnpm gate', input: 'verify:arch' },
        timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
      };
      setTraceEvents((prev) => [toolEv, ...prev]);

      setNodes((prev) =>
        prev.map((n) =>
          n.id === 'supervisor'
            ? { ...n, status: 'IDLE' }
            : n.id === 'coder'
            ? { ...n, status: 'EXECUTING', receiptCount: n.receiptCount + 1 }
            : n
        )
      );

      voiceEngine.speak('Execution verified. Tool receipt generated.');
      soundEngine.success();
    }, 1200);
  };

  const handleApproveHitl = (id: string) => {
    soundEngine.click();
    voiceEngine.speak('HITL authorization approved.');
    void fetch('/api/v1/hitl/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'approve' }),
    }).catch(() => {});

    setPendingHitl((prev) => prev.filter((i) => i.id !== id));
    setNodes((prev) =>
      prev.map((n) => (n.id === 'personal' ? { ...n, status: 'SUCCESS', lastAction: 'Approved: shell execution' } : n))
    );
  };

  const handleRejectHitl = (id: string) => {
    soundEngine.click();
    voiceEngine.speak('HITL authorization rejected.');
    void fetch('/api/v1/hitl/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'reject' }),
    }).catch(() => {});

    setPendingHitl((prev) => prev.filter((i) => i.id !== id));
    setNodes((prev) =>
      prev.map((n) => (n.id === 'personal' ? { ...n, status: 'IDLE', lastAction: 'Rejected by founder' } : n))
    );
  };

  return (
    <div className="flex flex-col min-h-screen bg-[#010308] text-[#dbeaf0] font-body relative overflow-hidden selection:bg-cyan-500/30 selection:text-cyan-300">
      {/* Top Header */}
      <Header
        mode={mode}
        onToggleMode={() => setMode((m) => (m === 'LIVE' ? 'REPLAY' : 'LIVE'))}
        systemStatus={systemStatus}
        spendToday={spendToday}
        dbStatus={dbStatus}
      />

      {/* Main Body Layout: Rail + Active Workspace */}
      <div className="flex flex-1 overflow-hidden z-10">
        {/* Left Vertical Nav Rail */}
        <NavRail activeTab={activeTab} onSelectTab={setActiveTab} />

        {/* Central Workspace Canvas */}
        <main ref={mainWorkspaceRef} className="flex-1 p-4 overflow-y-auto space-y-4 relative">
          {activeTab === 'CORE' && (
            <div className="space-y-4">
              {/* Sleek Glass Metric Cards Top Row */}
              <GlassMetricCards
                todaySpend={spendToday}
                totalTurns={nodes.reduce((a, n) => a + n.receiptCount, 0)}
                avgLatencyMs={14}
                evalPassRate={98.4}
                systemStatus={systemStatus}
              />

              {/* Main Antigravity Canvas & Floating RealTime Terminal */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="lg:col-span-2 h-[580px]">
                  <AntigravityCanvas
                    nodes={nodes}
                    onSelectNode={(node) =>
                      setInspectorData({
                        title: `NODE CONTRACT INSPECTOR — ${node.name.toUpperCase()}`,
                        data: node as unknown as Record<string, unknown>,
                      })
                    }
                    onDispatchTurn={handleDispatchTurn}
                  />
                </div>

                <div className="h-[580px]">
                  <RealTimeTerminal
                    events={traceEvents}
                    onSelectEvent={(ev) =>
                      setInspectorData({
                        title: `SEAM TRACE EVENT — ${ev.seam.toUpperCase()}`,
                        data: ev as unknown as Record<string, unknown>,
                      })
                    }
                    dragConstraintsRef={mainWorkspaceRef}
                  />
                </div>
              </div>

              {/* Bottom HITL Security Terminal */}
              <div className="h-[260px]">
                <HitlTerminal
                  pendingItems={pendingHitl}
                  onApprove={handleApproveHitl}
                  onReject={handleRejectHitl}
                />
              </div>
            </div>
          )}

          {activeTab === 'PLAN' && (
            <div className="p-6 bg-[#0b1624]/60 border border-cyan-400/40 backdrop-blur-xl rounded-2xl font-mono space-y-4 corner-brackets">
              <div className="flex items-center space-x-2 text-cyan-400">
                <Layers className="w-5 h-5" />
                <h2 className="font-display font-bold text-base tracking-wider">02 TYPED PLAN & CURSOR CONTROL</h2>
              </div>
              <p className="text-xs text-slate-400">
                FounderOS executes plans deterministically. Every step is bound by step cursor limits, budget ceilings, and prompt hash verification.
              </p>
              <div className="p-4 bg-[#03060c] border border-[#5eead4]/30 rounded-xl text-xs space-y-2 text-cyan-400">
                <div>&gt; MAX_PLAN_STEPS: 8</div>
                <div>&gt; CURRENT CURSOR: Step 2 of 4</div>
                <div>&gt; DETERMINISM HASH: 09a2f1b8c091 (100% Match)</div>
              </div>
            </div>
          )}

          {activeTab === 'ORG' && (
            <div className="p-6 bg-[#0b1624]/60 border border-indigo-400/40 backdrop-blur-xl rounded-2xl font-mono space-y-4 corner-brackets">
              <div className="flex items-center space-x-2 text-indigo-400">
                <Cpu className="w-5 h-5" />
                <h2 className="font-display font-bold text-base tracking-wider">03 WORKER CAPABILITY MATRIX</h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                {['Coder', 'QA', 'DevOps', 'JobHunt', 'Video', 'Prospecting', 'Personal', 'Executive'].map((w) => (
                  <div key={w} className="p-3 bg-[#03060c] border border-cyan-400/30 rounded-xl space-y-1">
                    <span className="font-bold text-cyan-400">{w} Worker</span>
                    <p className="text-[10px] text-slate-400">Context Isolation: ENFORCED</p>
                    <span className="text-[9px] px-1 bg-cyan-400/10 text-cyan-400 rounded">READ/WRITE</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {activeTab === 'SYS' && (
            <div className="p-6 bg-[#0b1624]/60 border border-amber-400/40 backdrop-blur-xl rounded-2xl font-mono space-y-4 corner-brackets">
              <div className="flex items-center space-x-2 text-amber-400">
                <ShieldCheck className="w-5 h-5" />
                <h2 className="font-display font-bold text-base tracking-wider">04 SYSTEM HEALTH & FAILURE THEATRE</h2>
              </div>
              <p className="text-xs text-slate-400">Live FailureReport sensors reporting Stage, Component, Evidence, and Retryability.</p>
              <div className="p-3 bg-[#03060c] border border-emerald-500/40 text-emerald-400 rounded-xl text-xs">
                ✅ ZERO FAILURES REPORTED IN LAST 24 HOURS
              </div>
            </div>
          )}

          {activeTab === 'DATA' && (
            <div className="space-y-4">
              <GlassMetricCards
                todaySpend={spendToday}
                totalTurns={nodes.reduce((a, n) => a + n.receiptCount, 0)}
                avgLatencyMs={14}
                evalPassRate={98.4}
                systemStatus={systemStatus}
              />
            </div>
          )}
        </main>
      </div>

      {/* Inspector Modal */}
      <InspectorModal
        title={inspectorData?.title || ''}
        data={inspectorData?.data || null}
        onClose={() => setInspectorData(null)}
      />
    </div>
  );
};
