import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { Database, Network, Search, Share2, Layers } from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';

interface EntityNode {
  id: string;
  label: string;
  type: 'CORE' | 'TOOL' | 'MEMORY' | 'GRAPH';
  x: number;
  y: number;
}

interface EntityTriple {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

const SAMPLE_ENTITIES: EntityNode[] = [
  { id: 'founderos', label: 'FounderOS v3', type: 'CORE', x: 50, y: 40 },
  { id: 'langgraph', label: 'LangGraph Supervisor', type: 'CORE', x: 25, y: 25 },
  { id: 'hermes', label: 'Hermes Skill Synthesizer', type: 'TOOL', x: 75, y: 25 },
  { id: 'cognee', label: 'Cognee Entity-Graph RAG', type: 'MEMORY', x: 25, y: 70 },
  { id: 'turicks', label: 'turicks_brain Vectors', type: 'MEMORY', x: 75, y: 70 },
  { id: 'postgres', label: 'PostgreSQL + pgvector', type: 'GRAPH', x: 50, y: 85 },
];

const SAMPLE_TRIPLES: EntityTriple[] = [
  { subject: 'FounderOS v3', predicate: 'uses_kernel', object: 'LangGraph Supervisor', confidence: 0.98 },
  { subject: 'FounderOS v3', predicate: 'synthesizes_skills_via', object: 'Hermes Skill Synthesizer', confidence: 0.95 },
  { subject: 'FounderOS v3', predicate: 'traverses_knowledge', object: 'Cognee Entity-Graph RAG', confidence: 0.96 },
  { subject: 'FounderOS v3', predicate: 'embeds_memory_in', object: 'turicks_brain Vectors', confidence: 0.99 },
  { subject: 'Cognee Entity-Graph RAG', predicate: 'persisted_in', object: 'PostgreSQL + pgvector', confidence: 0.99 },
  { subject: 'turicks_brain Vectors', predicate: 'persisted_in', object: 'PostgreSQL + pgvector', confidence: 0.99 },
];

export const CogneeEntityGraphVisualizer: React.FC = () => {
  const [selectedEntity, setSelectedEntity] = useState<EntityNode | null>(SAMPLE_ENTITIES[0]);
  const [searchQuery, setSearchQuery] = useState('');

  const filteredTriples = SAMPLE_TRIPLES.filter(
    (t) =>
      !searchQuery.trim() ||
      t.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.predicate.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.object.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="w-full bg-[#0b1624]/85 border border-[#5eead4]/40 shadow-[0_0_30px_rgba(3,6,12,0.9)] backdrop-blur-xl rounded-2xl p-5 font-mono space-y-5 corner-brackets">
      {/* Visualizer Header */}
      <div className="flex items-center justify-between border-b border-slate-700/60 pb-3">
        <div className="flex items-center space-x-3">
          <div className="p-2 rounded bg-cyan-400/10 border border-cyan-400/30 text-cyan-400">
            <Network className="w-5 h-5 animate-pulse" />
          </div>
          <div>
            <h3 className="font-display font-bold text-sm text-slate-100 tracking-wider">
              COGNEE ENTITY-GRAPH MEMORY RAG EXPLORER
            </h3>
            <p className="text-[10px] text-slate-400">
              Multi-Hop Graph Traversal Engine • [Subject] ──[Predicate]──► [Object]
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search graph triples..."
              className="bg-[#03060c] border border-slate-700 rounded-lg pl-8 pr-3 py-1 text-xs text-cyan-300 placeholder:text-slate-500 outline-none focus:border-cyan-400"
            />
          </div>
        </div>
      </div>

      {/* 2D Interactive Node Canvas */}
      <div className="relative w-full h-[320px] bg-[#03060c] border border-slate-800 rounded-xl overflow-hidden">
        {/* SVG Relationship Edge Lines */}
        <svg className="absolute inset-0 w-full h-full pointer-events-none">
          {SAMPLE_TRIPLES.map((t, idx) => {
            const src = SAMPLE_ENTITIES.find((e) => e.label === t.subject);
            const dst = SAMPLE_ENTITIES.find((e) => e.label === t.object);
            if (!src || !dst) return null;

            return (
              <g key={`edge-${idx}`}>
                <line
                  x1={`${src.x}%`}
                  y1={`${src.y}%`}
                  x2={`${dst.x}%`}
                  y2={`${dst.y}%`}
                  stroke="rgba(94, 234, 212, 0.4)"
                  strokeWidth="1.5"
                  strokeDasharray="4 4"
                />
              </g>
            );
          })}
        </svg>

        {/* Entity Nodes */}
        {SAMPLE_ENTITIES.map((entity) => {
          const isSelected = selectedEntity?.id === entity.id;
          return (
            <motion.div
              key={entity.id}
              onClick={() => {
                soundEngine.click();
                setSelectedEntity(entity);
              }}
              whileHover={{ scale: 1.08 }}
              style={{ left: `${entity.x}%`, top: `${entity.y}%` }}
              className={`absolute -translate-x-1/2 -translate-y-1/2 cursor-pointer px-3 py-1.5 rounded-lg border text-xs backdrop-blur-md transition-all shadow-lg ${
                isSelected
                  ? 'bg-cyan-400 text-black border-cyan-300 font-bold shadow-[0_0_20px_rgba(94,234,212,0.6)]'
                  : 'bg-[#0b1624]/90 text-slate-200 border-cyan-400/30 hover:border-cyan-400'
              }`}
            >
              <div className="flex items-center space-x-1.5">
                <Database className="w-3 h-3 text-cyan-400" />
                <span className="truncate">{entity.label}</span>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Triples List Table */}
      <div className="space-y-2">
        <h4 className="text-xs font-bold text-slate-300 uppercase tracking-widest flex items-center space-x-1.5">
          <Layers className="w-3.5 h-3.5 text-cyan-400" />
          <span>Active Entity Triples ({filteredTriples.length})</span>
        </h4>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
          {filteredTriples.map((t, idx) => (
            <div
              key={idx}
              className="p-2.5 bg-[#03060c] border border-slate-800 rounded-lg flex items-center justify-between text-slate-300 hover:border-cyan-400/50 transition-colors"
            >
              <div className="flex items-center space-x-1.5 truncate">
                <span className="font-semibold text-cyan-300 truncate">{t.subject}</span>
                <span className="text-[10px] px-1 bg-purple-500/20 text-purple-300 rounded border border-purple-500/30">
                  {t.predicate}
                </span>
                <span className="font-semibold text-indigo-300 truncate">{t.object}</span>
              </div>
              <span className="text-[10px] font-mono text-slate-500 shrink-0">
                {(t.confidence * 100).toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
