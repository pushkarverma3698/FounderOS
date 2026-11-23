/**
 * Mac worker client: the Mac's side of /apply/mac-worker/* (mac-worker-api.ts), bearer-token auth.
 */

import type { MacApi, MacLease, ResultInput } from "./mac-worker-loop.js";
import type { MacPacket } from "./mac-worker-packet.js";

export function createMacClient(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): MacApi {
  const root = `${baseUrl.replace(/\/+$/, "")}/apply/mac-worker`;
  const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const res = await fetchImpl(`${root}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok && res.status !== 204) throw new Error(`${path} -> HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
  };
  const q = (l: MacLease): string => `rowId=${encodeURIComponent(l.rowId)}&leaseId=${encodeURIComponent(l.leaseId)}`;
  return {
    heartbeat: async () => void (await call("heartbeat", { method: "POST" })),
    async lease() {
      const res = await call("lease", { method: "POST" });
      if (res.status === 204) return null;
      const body = (await res.json()) as MacLease;
      return { leaseId: body.leaseId, rowId: body.rowId };
    },
    async packet(l) {
      return (await (await call(`packet?${q(l)}`)).json()) as MacPacket;
    },
    async cv(l) {
      return Buffer.from(await (await call(`cv?${q(l)}`)).arrayBuffer());
    },
    result: async (body: ResultInput) => void (await call("result", { method: "POST", body: JSON.stringify(body) })),
  };
}
