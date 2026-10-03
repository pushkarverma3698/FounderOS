/** Every credential `/login` can renew. Add a tool = add its adapter here. */

import type { LoginAdapter } from "./types.js";
import { googleAdapter } from "./adapters/google.js";
import { claudeAdapter } from "./adapters/claude.js";
import { agyAdapter } from "./adapters/agy.js";

export const LOGIN_ADAPTERS: readonly LoginAdapter[] = [googleAdapter, claudeAdapter, agyAdapter];
