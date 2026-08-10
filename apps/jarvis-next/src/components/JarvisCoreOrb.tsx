import React from 'react';
import { Cpu, Zap, Shield, Radio } from 'lucide-react';

interface JarvisCoreOrbProps {
  status: 'IDLE' | 'EXECUTING' | 'TOOL_CALL' | 'HITL_PAUSE' | 'SUCCESS';
  activeTurnCount: number;
}

export const JarvisCoreOrb: React.FC<JarvisCoreOrbProps> = ({ status, activeTurnCount }) => {
  return (
    <div className="relative flex flex-col items-center justify-center pointer-events-none select-none">
      {/* Outer Rotating Conic Radar Glow */}
      <div className="relative w-48 h-48 flex items-center justify-center">
        <div className="absolute inset-0 rounded-full border border-[#5eead4]/30 animate-spin opacity-40 [animation-duration:12s]" />
        <div className="absolute inset-2 rounded-full border border-dashed border-[#818cf8]/40 animate-spin opacity-60 [animation-duration:8s] [animation-direction:reverse]" />

        {/* Dynamic Holographic Pulsing Reactor Core */}
        <div
          className={`relative w-28 h-28 rounded-full flex flex-col items-center justify-center backdrop-blur-md transition-all duration-500 border ${
            status === 'HITL_PAUSE'
              ? 'bg-[#fbbf24]/10 border-amberGlow shadow-[0_0_50px_rgba(251,191,36,0.5)] animate-pulse'
              : status === 'EXECUTING' || status === 'TOOL_CALL'
              ? 'bg-[#5eead4]/15 border-[#5eead4] shadow-[0_0_60px_rgba(94,234,212,0.6)] animate-pulse'
              : 'bg-[#0b1624]/80 border-[#5eead4]/40 shadow-[0_0_35px_rgba(94,234,212,0.25)]'
          }`}
        >
          {/* Inner Glowing Orb Nucleus */}
          <div className="w-14 h-14 rounded-full bg-gradient-to-tr from-[#5eead4] via-[#818cf8] to-[#eefffb] flex items-center justify-center shadow-inner animate-pulse">
            <Cpu className="w-7 h-7 text-[#03060c] animate-spin [animation-duration:20s]" />
          </div>

          {/* Audio Wave Visualizer Bars */}
          <div className="flex items-center space-x-1 mt-2">
            {[0.4, 0.8, 1, 0.6, 0.9, 0.5, 0.7].map((h, i) => (
              <div
                key={i}
                style={{ height: `${h * 12}px`, animationDelay: `${i * 0.1}s` }}
                className="w-1 bg-[#5eead4] rounded-full animate-bounce [animation-duration:0.8s]"
              />
            ))}
          </div>
        </div>

        {/* Laser Beams Firing Outward */}
        <div className="absolute -inset-4 rounded-full border border-[#5eead4]/10 animate-ping opacity-20 pointer-events-none" />
      </div>

      {/* Holographic Text Badge */}
      <div className="mt-3 flex flex-col items-center">
        <div className="flex items-center space-x-2 px-3 py-1 rounded-full bg-[#0b1624]/90 border border-[#5eead4]/50 shadow-[0_0_15px_rgba(94,234,212,0.3)]">
          <Zap className="w-3.5 h-3.5 text-[#5eead4] animate-pulse" />
          <span className="font-display font-bold text-xs tracking-widest text-[#dbeaf0]">
            JARVIS CORE KERNEL
          </span>
          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[#5eead4]/20 text-[#5eead4]">
            {status}
          </span>
        </div>
        <p className="text-[10px] font-mono text-dimText mt-1 tracking-wider">
          ACTIVE DISPATCHES: <strong className="text-[#5eead4]">{activeTurnCount}</strong>
        </p>
      </div>
    </div>
  );
};
