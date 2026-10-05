/** Every credential `/login` can renew. Add a tool = add its adapter here. */

import type { LoginAdapter } from "./types.js";
import { googleAdapter } from "./adapters/google.js";
import { claudeAdapter } from "./adapters/claude.js";
import { agyAdapter as agyLocal } from "./adapters/agy.js";
import { createAgyRemoteAdapter } from "./adapters/agy-remote.js";

/** In production agy is reached through the helper socket (agy-helper.ts); with no socket the local adapter runs as before. */
const agyAdapter = createAgyRemoteAdapter(agyLocal);

export const LOGIN_ADAPTERS: readonly LoginAdapter[] = [googleAdapter, claudeAdapter, agyAdapter];
