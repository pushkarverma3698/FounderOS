import { Terminal, Wrench, Briefcase, Video, Target, Clock, BrainCircuit, Cpu } from 'lucide-react';
import type { DepartmentNodeData, SupervisorNodeData } from '../types/graph';

/**
 * The seven ReAct departments the headless LangGraph kernel actually dispatches
 * to, plus the pure-code supervisor that routes between them. Slot order here is
 * the orbit order — index 0 sits at 12 o'clock and advances clockwise.
 */
export const DEPARTMENTS: DepartmentNodeData[] = [
  {
    id: 'engineering',
    name: 'Engineering',
    department: 'Code & Contracts',
    status: 'EXECUTING',
    lastAction: 'pnpm gate — verify:arch',
    icon: Terminal,
    receiptCount: 18,
  },
  {
    id: 'infra',
    name: 'Infra & QA',
    department: 'Runtime Ops',
    status: 'IDLE',
    lastAction: 'Postgres health check ok',
    icon: Wrench,
    receiptCount: 14,
  },
  {
    id: 'career',
    name: 'Career Engine',
    department: 'Job Hunt Pipeline',
    status: 'TOOL_CALL',
    lastAction: 'Screening ATS Workable form',
    icon: Briefcase,
    receiptCount: 29,
  },
  {
    id: 'creative',
    name: 'Video Factory',
    department: 'Creative Engine',
    status: 'IDLE',
    lastAction: 'Kling I2V prompt staged',
    icon: Video,
    receiptCount: 12,
  },
  {
    id: 'revenue',
    name: 'Prospecting',
    department: 'Revenue Engine',
    status: 'IDLE',
    lastAction: 'Scraping target ICP list',
    icon: Target,
    receiptCount: 15,
  },
  {
    id: 'intelligence',
    name: 'Brain & RAG',
    department: 'Memory Substrate',
    status: 'EXECUTING',
    lastAction: 'Embedding 2,418 session chunks',
    icon: BrainCircuit,
    receiptCount: 33,
  },
  {
    id: 'exec',
    name: 'Executive Ops',
    department: 'Founder Support',
    status: 'HITL_PAUSE',
    lastAction: 'Gated: shell execution',
    icon: Clock,
    receiptCount: 8,
  },
];

export const SUPERVISOR: SupervisorNodeData = {
  id: 'supervisor',
  name: 'Supervisor Kernel',
  department: 'Pure-Code Dispatch',
  status: 'IDLE',
  lastAction: 'Listening on gateway',
  icon: Cpu,
  receiptCount: 42,
};
