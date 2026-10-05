/** What the Telegram gateway imports for /login: the command, plus the production dependencies (the DB-backed audit trail). */

import type { ChatAccessConfig } from "../chat-access.js";
import { defaultLoginDeps, type LoginDeps } from "./command.js";
import { dbLoginAudit } from "./login-audit-db.js";

export { handleLogin, handleLoginReply } from "./command.js";

export const productionLoginDeps = (access: ChatAccessConfig): LoginDeps => defaultLoginDeps(access, dbLoginAudit);
