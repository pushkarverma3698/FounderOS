/**
 * FounderOS — JARVIS static asset server
 * Serves apps/jarvis/dist from the health HTTP server with SPA fallback.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Resolve JARVIS dist root (override for tests). */
export function jarvisDistRoot(override?: string): string {
  if (override) return override;
  const envRoot = process.env["JARVIS_DIST_ROOT"]?.trim();
  if (envRoot) return envRoot;
  return join(process.cwd(), "apps/jarvis/dist");
}

export function jarvisDistAvailable(root = jarvisDistRoot()): boolean {
  return existsSync(join(root, "index.html"));
}

/** Map URL path to a safe file under dist root. Returns null if traversal attempt. */
export function resolveStaticFile(urlPath: string, root = jarvisDistRoot()): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\//, "");
  const abs = normalize(join(root, rel));
  if (!abs.startsWith(normalize(root))) return null;
  return abs;
}

function cacheControl(ext: string): string {
  if (ext === ".html") return "no-cache";
  return "public, max-age=31536000, immutable";
}

/** Serve a static file or SPA index.html fallback. Returns true if handled. */
export async function serveJarvisStatic(
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
  root = jarvisDistRoot(),
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (!jarvisDistAvailable(root)) return false;

  let filePath = resolveStaticFile(urlPath, root);
  if (!filePath) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "forbidden" }));
    return true;
  }

  try {
    const st = await stat(filePath);
    if (!st.isFile()) {
      filePath = join(root, "index.html");
    }
  } catch {
    filePath = join(root, "index.html");
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
    return true;
  }

  const ext = extname(filePath);
  const headers: Record<string, string> = {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": cacheControl(ext),
  };

  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return true;
  }

  res.writeHead(200, headers);
  createReadStream(filePath).pipe(res);
  return true;
}
