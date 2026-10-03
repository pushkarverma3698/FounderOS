/** Every credential `/login` can renew. Add a tool = add its adapter here. */

import type { LoginAdapter } from "./types.js";
import { googleAdapter } from "./adapters/google.js";

export const LOGIN_ADAPTERS: readonly LoginAdapter[] = [googleAdapter];
