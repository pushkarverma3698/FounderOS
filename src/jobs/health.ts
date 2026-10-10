/**
 * /health for the jobs process. The VPS watchdog (~/bin/founderos-watchdog.sh) curls
 * http://127.0.0.1:3001/health every 2 minutes and restarts the unit after 3 failures,
 * so this answers 200 whenever the event loop is alive. The body says whether Postgres
 * answered, for a human reading it; a database blip is not a reason to kill the bot.
 */
import { createServer, type Server } from "node:http";
import { getPgPool } from "../db/client.js";
import { logger } from "../infra/logger.js";

const log = logger.child({ module: "jobs-health" });

async function dbAlive(): Promise<boolean> {
  try {
    await getPgPool().query("select 1");
    return true;
  } catch (err) {
    // allow-failopen: the report says db:false; liveness of the process is what the watchdog needs.
    log.warn({ err: (err as Error).message }, "Health: database ping failed");
    return false;
  }
}

export function startJobsHealthServer(port = Number(process.env["HEALTH_PORT"] ?? 3001)): Server {
  const server = createServer((req, res) => {
    if (req.method !== "GET" || (req.url ?? "").split("?")[0] !== "/health") {
      res.writeHead(404).end();
      return;
    }
    void dbAlive().then((db) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "jobs", db, uptimeSec: Math.round(process.uptime()) }));
    });
  });
  server.listen(port, "127.0.0.1", () => log.info({ port }, "Health server on /health"));
  return server;
}
