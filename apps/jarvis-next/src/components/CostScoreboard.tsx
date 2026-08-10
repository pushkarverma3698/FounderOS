import React from 'react';
import { DollarSign, Clock, CheckCircle2, ShieldCheck, TrendingUp, BarChart3 } from 'lucide-react';

interface CostScoreboardProps {
  todaySpend: number;
  totalTurns: number;
  avgLatencyMs: number;
  evalPassRate: number;
}

export const CostScoreboard: React.FC<CostScoreboardProps> = ({
  todaySpend,
  totalTurns,
  avgLatencyMs,
  evalPassRate,
}) => {
  return (
    <div className="w-full h-full bg-[#03060c] border border-borderTeal rounded-lg p-4 font-mono space-y-4 flex flex-col justify-between">
      {/* Top Header */}
      <div className="flex items-center justify-between pb-2 border-b border-borderTeal/50">
        <div className="flex items-center space-x-2">
          <BarChart3 className="w-4 h-4 text-[#5eead4]" />
          <span className="font-display font-bold text-xs text-[#dbeaf0] tracking-wider">
            COST LEDGER & EVAL SCOREBOARD
          </span>
        </div>
        <span className="text-[10px] text-dimText">FALSIFIABLE TELEMETRY MATRIX</span>
      </div>

      {/* Grid Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="bg-[#0b1624]/80 border border-borderTeal/40 p-3 rounded-lg flex flex-col justify-between">
          <div className="flex items-center justify-between text-dimText">
            <span className="text-[10px]">TODAY SPEND</span>
            <DollarSign className="w-3.5 h-3.5 text-[#5eead4]" />
          </div>
          <span className="font-display font-bold text-lg text-[#5eead4] mt-2">
            ${todaySpend.toFixed(4)}
          </span>
          <span className="text-[9px] text-dimText mt-1">Cap: $5.0000 / day</span>
        </div>

        <div className="bg-[#0b1624]/80 border border-borderTeal/40 p-3 rounded-lg flex flex-col justify-between">
          <div className="flex items-center justify-between text-dimText">
            <span className="text-[10px]">TOTAL TURNS</span>
            <TrendingUp className="w-3.5 h-3.5 text-indigoGlow" />
          </div>
          <span className="font-display font-bold text-lg text-[#dbeaf0] mt-2">
            {totalTurns}
          </span>
          <span className="text-[9px] text-dimText mt-1">Avg: ${(todaySpend / (totalTurns || 1)).toFixed(4)} / turn</span>
        </div>

        <div className="bg-[#0b1624]/80 border border-borderTeal/40 p-3 rounded-lg flex flex-col justify-between">
          <div className="flex items-center justify-between text-dimText">
            <span className="text-[10px]">KERNEL LATENCY</span>
            <Clock className="w-3.5 h-3.5 text-amberGlow" />
          </div>
          <span className="font-display font-bold text-lg text-amberGlow mt-2">
            {avgLatencyMs}ms
          </span>
          <span className="text-[9px] text-dimText mt-1">Kernel: 9ms · Model: 14s</span>
        </div>

        <div className="bg-[#0b1624]/80 border border-borderTeal/40 p-3 rounded-lg flex flex-col justify-between">
          <div className="flex items-center justify-between text-dimText">
            <span className="text-[10px]">EVAL REGRESSION</span>
            <CheckCircle2 className="w-3.5 h-3.5 text-[#5eead4]" />
          </div>
          <span className="font-display font-bold text-lg text-[#5eead4] mt-2">
            {evalPassRate}%
          </span>
          <span className="text-[9px] text-dimText mt-1">Golden Set: 200 tasks</span>
        </div>
      </div>

      {/* Latency & Cost Breakdown Chart / Bar */}
      <div className="bg-[#0b1624]/60 border border-borderTeal/40 p-3 rounded-lg space-y-2">
        <span className="text-[11px] font-bold text-mutedText">LATENCY WATERFALL BREAKDOWN</span>
        <div className="space-y-1.5 text-[10px]">
          <div>
            <div className="flex justify-between text-dimText mb-0.5">
              <span>Kernel Supervisor Dispatch</span>
              <span className="text-[#5eead4] font-bold">9ms (0.1%)</span>
            </div>
            <div className="w-full h-1.5 bg-[#03060c] rounded overflow-hidden">
              <div className="h-full bg-[#5eead4] w-[2%]" />
            </div>
          </div>

          <div>
            <div className="flex justify-between text-dimText mb-0.5">
              <span>Worker Tool Execution & Sandbox</span>
              <span className="text-indigoGlow font-bold">142ms (1.0%)</span>
            </div>
            <div className="w-full h-1.5 bg-[#03060c] rounded overflow-hidden">
              <div className="h-full bg-indigoGlow w-[8%]" />
            </div>
          </div>

          <div>
            <div className="flex justify-between text-dimText mb-0.5">
              <span>LLM Inference (Gemini / Anthropic)</span>
              <span className="text-amberGlow font-bold">14,280ms (98.9%)</span>
            </div>
            <div className="w-full h-1.5 bg-[#03060c] rounded overflow-hidden">
              <div className="h-full bg-amberGlow w-[98%]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
