/**
 * A list tool that asks GitHub for `per_page` rows and gets exactly that many has been cut
 * short. The result says so, so the reply never presents a capped page as "all of them".
 */

import type { ToolResult } from "./index.js";

export function listResult(data: unknown[], perPage: number): ToolResult {
  if (data.length < perPage) return { success: true, data };
  return {
    success: true,
    data,
    truncated: true,
    note: `Showing the first ${data.length}; more exist. Narrow with since/state.`,
  };
}
