import type { FC } from 'react';

export type NodeStatus =
  | 'IDLE'
  | 'EXECUTING'
  | 'TOOL_CALL'
  | 'HITL_PAUSE'
  | 'SUCCESS'
  | 'ERROR';

export interface DepartmentNodeData {
  id: string;
  name: string;
  department: string;
  status: NodeStatus;
  lastAction: string;
  icon: FC<{ className?: string }>;
  receiptCount: number;
}

export type SupervisorNodeData = DepartmentNodeData;

/** A node is "streaming" when the kernel is actively routing work through it. */
export function isStreaming(status: NodeStatus): boolean {
  return status === 'EXECUTING' || status === 'TOOL_CALL';
}
