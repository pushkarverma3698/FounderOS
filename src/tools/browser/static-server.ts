/**
 * FounderOS — throwaway loopback static server for UI checks
 * ============================================================
 * Serves ONE directory on 127.0.0.1 with an ephemeral port, applying
 * `{{PLACEHOLDER}}` substitutions to HTML on the way out, so a scaffold can be
 * checked exactly as a visitor would receive it.
 *
 * ## Why a server and not file:// + setContent
 *
 * Both simpler routes are measurably wrong, and the live run proved each:
 *
 *   goto(directory) then setContent — Chromium answers a file:// directory with
 *   its own built-in listing page, whose inline script throws
 *   `start is not defined` / `addRow is not defined`. Those land in the
 *   pageerror listener before setContent replaces the document, so every page
 *   reported four uncaught JavaScript errors it did not have.
 *
 *   setContent + <base href="file://…/"> — a document created by setContent has
 *   an about:blank origin, and Chromium refuses its file:// subresource loads:
 *   "Not allowed to load local resource". Every preset then reported a missing
 *   stylesheet that was sitting right next to it.
 *
 * Serving over HTTP fixes both and is more faithful besides: a deployed Proof
 * Drop is served over HTTP, not opened off a disk.
 *
 * Scope: binds to loopback only, serves nothing outside `dir`, and is closed by
 * the caller as soon as the page is measured.
 */

import { createServer, type Server } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, extname, relative, isAbsolute } from "node:path";
import type { AddressInfo } from "node:net";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
};

export interface StaticServer {
  /** e.g. "http://127.0.0.1:41233" */
  readonly origin: string;
  close(): Promise<void>;
}

/**
 * Resolve a URL path to a file inside `root`, or null if it escapes.
 *
 * PURE and exported so the traversal guard is unit-tested: this server reads
 * from disk on behalf of a page, so "../../.env" must never resolve.
 */
export function resolveWithinRoot(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const candidate = resolve(join(root, decoded));
  const rel = relative(resolve(root), candidate);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}

/** Apply `{{KEY}}` → value substitutions. PURE. */
export function substitute(html: string, substitutions: Record<string, string>): string {
  let out = html;
  for (const [key, value] of Object.entries(substitutions)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
}

/** Start the server. Resolves once it is listening. */
export async function serveDirectory(
  dir: string,
  substitutions: Record<string, string> = {},
): Promise<StaticServer> {
  const root = resolve(dir);

  const server: Server = createServer((req, res) => {
    const filePath = resolveWithinRoot(root, req.url ?? "/");
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const ext = extname(filePath).toLowerCase();
    const type = CONTENT_TYPES[ext] ?? "application/octet-stream";

    if (ext === ".html") {
      res.writeHead(200, { "Content-Type": type });
      res.end(substitute(readFileSync(filePath, "utf8"), substitutions));
      return;
    }

    res.writeHead(200, { "Content-Type": type });
    res.end(readFileSync(filePath));
  });

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", ok);
  });

  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((ok) => {
        server.close(() => ok());
      }),
  };
}
