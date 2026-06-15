/**
 * FounderOS v2 — Dynamic Tool Registry
 * =====================================
 * Single registry where tools declare their metadata (departments, subagents,
 * hitl-gating, description/prompts) directly.
 */

export interface ToolRegistrationMetadata {
  departments?: string[];
  subagents?: string[]; // e.g., ["coder", "qa", "devops"]
  hitlGated?: boolean;
  isSupervisor?: boolean;
  promptDescription?: string;
  notes?: string;
}

export class ToolRegistry {
  private static instance: ToolRegistry;
  private tools: Map<any, ToolRegistrationMetadata> = new Map();

  static getInstance(): ToolRegistry {
    if (!ToolRegistry.instance) {
      ToolRegistry.instance = new ToolRegistry();
    }
    return ToolRegistry.instance;
  }

  register(tool: any, metadata: ToolRegistrationMetadata) {
    if (!tool || typeof tool !== "object" || !tool.name) {
      throw new Error("Invalid tool registration: tool must be a LangChain StructuredTool instance");
    }
    this.tools.set(tool, metadata);
  }

  getMetadata(tool: any): ToolRegistrationMetadata | undefined {
    return this.tools.get(tool);
  }

  getToolsForDepartment(dept: string): any[] {
    const list: any[] = [];
    for (const [tool, meta] of this.tools.entries()) {
      if (meta.departments?.includes(dept)) {
        list.push(tool);
      }
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  getToolsForSubagent(subagent: string): any[] {
    const list: any[] = [];
    for (const [tool, meta] of this.tools.entries()) {
      if (meta.subagents?.includes(subagent)) {
        list.push(tool);
      }
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  getSupervisorTools(): any[] {
    const list: any[] = [];
    for (const [tool, meta] of this.tools.entries()) {
      if (meta.isSupervisor) {
        list.push(tool);
      }
    }
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }

  getHitlGatedToolNames(): Set<string> {
    const names = new Set<string>();
    for (const [tool, meta] of this.tools.entries()) {
      if (meta.hitlGated) {
        names.add(tool.name);
      }
    }
    return names;
  }

  getToolNotes(): string[] {
    const notes: string[] = [];
    for (const [tool, meta] of this.tools.entries()) {
      if (meta.notes) {
        notes.push(`- ${tool.name} = ${meta.notes}`);
      }
    }
    return notes.sort();
  }
}

export function registerTool<T>(tool: T, metadata: ToolRegistrationMetadata): T {
  ToolRegistry.getInstance().register(tool, metadata);
  return tool;
}

export function fillTemplates(promptText: string): string {
  const registry = ToolRegistry.getInstance();

  const getList = (tools: any[]) => {
    return tools
      .map((t) => {
        const meta = registry.getMetadata(t);
        const desc = meta?.promptDescription || t.description;
        return `- ${t.name} → ${desc}`;
      })
      .join("\n");
  };

  const getSupervisorList = (tools: any[]) => {
    return tools
      .map((t) => {
        const meta = registry.getMetadata(t);
        const desc = meta?.promptDescription || t.description;
        return `- ${t.name}   → ${desc}`;
      })
      .join("\n");
  };

  return promptText
    .replace("{{RESEARCH_TOOLS}}", () => getList(registry.getToolsForDepartment("research")))
    .replace("{{COMMS_TOOLS}}", () => getList(registry.getToolsForDepartment("comms")))
    .replace("{{ENGINEERING_TOOLS}}", () => getList(registry.getToolsForDepartment("engineering")))
    .replace("{{PERSONAL_TOOLS}}", () => getList(registry.getToolsForDepartment("personal")))
    .replace("{{JOBHUNT_TOOLS}}", () => getList(registry.getToolsForDepartment("jobhunt")))
    .replace("{{SUPERVISOR_TOOLS}}", () => getSupervisorList(registry.getSupervisorTools()));
}
