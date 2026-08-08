import React, { useState } from 'react';
import { JarvisCoreOrb } from './JarvisCoreOrb';
import { Cpu, Terminal, Briefcase, Video, Target, Clock, AlertTriangle, CheckCircle2, Play, Zap } from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';
import { voiceEngine } from '../audio/voiceEngine';

export interface NodeData {
  id: string;
  name: string;
  department: string;
  status: 'IDLE' | 'EXECUTING' | 'TOOL_CALL' | 'HITL_PAUSE' | 'SUCCESS' | 'ERROR';
  lastAction: string;
  x: number; // grid percentage X
  y: number; // grid percentage Y
  icon: React.FC<{ className?: string }>;
  receiptCount: number;
}

interface NodeGraphProps {
  nodes: NodeData[];
  onSelectNode: (node: NodeData) => void;
  onDispatchTurn: (prompt: string) => void;
}

export const NodeGraph: React.FC<NodeGraphProps> = ({ nodes, onSelectNode, onDispatchTurn }) => {
  const [promptInput, setPromptInput] = useState('');
  const [isDispatching, setIsDispatching] = useState(false);

  const handleDispatch = (e: React.FormEvent) => {
    e.preventDefault();
    if (!promptInput.trim()) return;
    soundEngine.dispatch();
    voiceEngine.speak(`Jarvis Core dispatching: ${promptInput}`);
    setIsDispatching(true);
    onDispatchTurn(promptInput);
    setPromptInput('');
    setTimeout(() => setIsDispatching(false), 800);
  };

  const activeTurnCount = nodes.filter((n) => n.status === 'EXECUTING' || n.status === 'TOOL_CALL').length;
  const coreStatus = nodes.find((n) => n.status === 'HITL_PAUSE')
    ? 'HITL_PAUSE'
    : activeTurnCount > 0
    ? 'EXECUTING'
    : 'IDLE';

  return (
    <div className="relative w-full h-full min-h-[540px] flex flex-col justify-between p-4 overflow-hidden select-none">
      {/* Central Holographic Reactor Core Orb */}
      <div className="absolute top-[42%] left-1/2 -translate-x-1/2 -translate-y-1/2 z-10">
        <JarvisCoreOrb status={coreStatus} activeTurnCount={activeTurnCount} />
      </div>

      {/* Dynamic Laser Beams connecting Core to Nodes */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none z-0">
        {nodes.map((node) => {
          if (node.id === 'supervisor') return null;
          const cx = 50;
          const cy = 42;
          const nx = node.x;
          const ny = node.y;
          const isActive = node.status === 'EXECUTING' || node.status === 'TOOL_CALL';

          return (
            <g key={`laser-${node.id}`}>
              <line
                x1={`${cx}%`}
                y1={`${cy}%`}
                x2={`${nx}%`}
                y2={`${ny}%`}
                stroke={isActive ? 'rgba(94, 234, 212, 0.8)' : 'rgba(94, 234, 212, 0.2)'}
                strokeWidth={isActive ? 2.5 : 1}
                strokeDasharray={isActive ? '6 6' : 'none'}
              />
              {isActive && (
                <line
                  x1={`${cx}%`}
                  y1={`${cy}%`}
                  x2={`${nx}%`}
                  y2={`${ny}%`}
                  stroke="#eefffb"
                  strokeWidth={4}
                  opacity={0.4}
                  className="animate-pulse"
                />
              )}
            </g>
          );
        })}
      </svg>

      {/* Floating Spatial Orbital Agent Nodes */}
      <div className="relative w-full h-[400px] z-20">
        {nodes.map((node) => {
          if (node.id === 'supervisor') return null;
          const Icon = node.icon;
          const isHitl = node.status === 'HITL_PAUSE';
          const isActive = node.status === 'EXECUTING' || node.status === 'TOOL_CALL';

          return (
            <div
              key={node.id}
              onClick={() => {
                soundEngine.click();
                onSelectNode(node);
              }}
              style={{ left: `${node.x}%`, top: `${node.y}%` }}
              className="absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer group transition-transform hover:scale-105"
            >
              <div
                className={`w-44 p-3 rounded-xl border backdrop-blur-xl transition-all corner-brackets ${
                  isHitl
                    ? 'bg-[#0b1624]/90 border-amberGlow shadow-[0_0_30px_rgba(251,191,36,0.4)] animate-pulse-slow'
                    : isActive
                    ? 'bg-[#0b1624]/90 border-[#5eead4] shadow-[0_0_35px_rgba(94,234,212,0.4)] glow-teal'
                    : 'bg-[#0b1624]/60 border-borderTeal hover:border-[#5eead4]/60 hover:bg-[#0b1624]/90 shadow-[0_0_20px_rgba(3,6,12,0.8)]'
                }`}
              >
                <div className="flex items-center space-x-2.5">
                  <div className={`p-2 rounded-lg ${isActive ? 'bg-[#5eead4] text-[#03060c] glow-teal' : 'bg-[#818cf8]/15 text-indigoGlow'}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <div className="truncate">
                    <h4 className="font-display font-bold text-xs text-[#dbeaf0] leading-tight truncate">
                      {node.name}
                    </h4>
                    <p className="text-[9px] font-mono text-dimText uppercase tracking-wider">{node.department}</p>
                  </div>
                </div>

                <div className="mt-2 pt-2 border-t border-borderTeal/40 flex items-center justify-between font-mono text-[10px]">
                  <span className={isActive ? 'text-[#5eead4] font-bold' : isHitl ? 'text-amberGlow font-bold' : 'text-dimText'}>
                    {node.status}
                  </span>
                  <span className="text-dimText">R:{node.receiptCount}</span>
                </div>

                {node.lastAction && (
                  <p className="mt-1 text-[10px] font-mono text-mutedText truncate">
                    &gt; {node.lastAction}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Floating Sci-Fi Dispatch Command Terminal */}
      <form
        onSubmit={handleDispatch}
        className="z-30 relative flex items-center space-x-3 bg-[#0b1624]/95 border border-[#5eead4]/50 shadow-[0_0_30px_rgba(94,234,212,0.2)] p-2.5 rounded-xl backdrop-blur-xl corner-brackets"
      >
        <div className="flex items-center space-x-2 px-2 border-r border-borderTeal/60">
          <Zap className="w-4 h-4 text-[#5eead4] animate-pulse" />
          <span className="font-mono text-xs font-bold text-[#5eead4] tracking-widest">DISPATCH</span>
        </div>

        <input
          type="text"
          value={promptInput}
          onChange={(e) => setPromptInput(e.target.value)}
          placeholder="Command 2035 Jarvis (e.g. 'Optimize jobhunt ATS applications & run pnpm gate')..."
          className="flex-1 bg-transparent font-mono text-xs text-[#dbeaf0] placeholder:text-dimText focus:outline-none"
        />

        <button
          type="submit"
          disabled={isDispatching || !promptInput.trim()}
          className="px-5 py-2 rounded-lg bg-gradient-to-r from-[#5eead4] to-[#7df3e2] text-[#03060c] font-mono font-bold text-xs hover:shadow-[0_0_20px_rgba(94,234,212,0.6)] disabled:opacity-40 transition-all flex items-center space-x-1.5 glow-teal"
        >
          <span>EXECUTE</span>
          <Play className="w-3.5 h-3.5 fill-current" />
        </button>
      </form>
    </div>
  );
};
