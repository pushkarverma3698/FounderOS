/**
 * Minimal type declaration for @composio-core/js.
 * Full types are not shipped by the package — this declaration
 * unblocks TypeScript compilation while keeping the import lazy.
 * Update when Composio ships official type definitions.
 */
declare module "@composio-core/js" {
  export interface OpenAIToolSetOptions {
    apiKey?: string;
    baseUrl?: string;
  }

  export interface ExecuteActionParams {
    action: string;
    params?: Record<string, unknown>;
    entityId?: string;
  }

  export class OpenAIToolSet {
    constructor(options?: OpenAIToolSetOptions);
    executeAction(params: ExecuteActionParams): Promise<unknown>;
    getTools(params?: { actions?: string[]; apps?: string[] }): Promise<unknown[]>;
  }
}
