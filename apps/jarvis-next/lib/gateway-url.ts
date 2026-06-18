/** Gateway base for browser API + SSE (bypasses Next.js rewrite — SSE hangs on proxy). */
export function gatewayBase(): string {
  if (typeof window === "undefined") {
    return process.env["JARVIS_GATEWAY_URL"] ?? "http://127.0.0.1:3001";
  }
  return process.env["NEXT_PUBLIC_JARVIS_GATEWAY_URL"] ?? "http://127.0.0.1:3001";
}

export function apiUrl(path: string): string {
  const base = gatewayBase().replace(/\/$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${base}${p}`;
}
