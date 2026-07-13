/**
 * FounderOS — MCP registry client (ADR-041 Tier 3)
 * =================================================
 * Search the official MCP registry (registry.modelcontextprotocol.io) and map
 * each result to a proposed bridge-manifest entry, so `/connect` can add a
 * server without the founder hand-writing JSON. The mapping is pure and
 * unit-tested; only `searchRegistry` touches the network.
 *
 * A registry server advertises transports as either `remotes` (hosted, →http)
 * or `packages` (runnable, →stdio). We map the first one we can actually run:
 *   remotes[streamable-http] → { transport:"http", url, headerEnv }
 *   packages[uvx|npx + stdio] → { transport:"stdio", command, args }
 * Docker/OCI-only servers are surfaced but marked unsupported (no auto-wiring).
 * Secrets are never inlined: a required secret header becomes a `headerEnv`
 * mapping to an env-var NAME the founder must set, mirroring the manifest rule.
 */

import { mcpServerSchema, type McpServerEntry } from "./bridge-manifest.js";

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io";

/** A manifest entry minus the founder-chosen `department`/`write` fields. */
export type ProposedEntry =
  | { transport: "http"; url: string; headerEnv?: Record<string, string> }
  | { transport: "stdio"; command: string; args: string[] };

export interface RegistrySuggestion {
  /** Full registry name, e.g. "com.mcparmory/notion". */
  name: string;
  description: string;
  /** Short manifest key derived from the name, e.g. "notion". */
  key: string;
  /** A runnable manifest entry, or null when we can't auto-wire this server. */
  proposed: ProposedEntry | null;
  /** Why `proposed` is null (e.g. docker-only). */
  unsupported?: string;
  /** Env-var NAMES the founder must set before the server will authenticate. */
  requiredSecrets: string[];
}

/** Shape of the fields we read off a registry `server` object (rest ignored). */
interface RawRegistryServer {
  name?: string;
  description?: string;
  remotes?: Array<{ type?: string; url?: string; headers?: Array<{ name?: string; value?: string; isSecret?: boolean; isRequired?: boolean }> }>;
  packages?: Array<{ registryType?: string; identifier?: string; runtimeHint?: string; transport?: { type?: string } }>;
}

/** Derive a short, collision-resistant manifest key from a registry name. */
export function serverKey(name: string): string {
  const tail = name.split(/[/.]/).filter(Boolean).pop() ?? name;
  const clean = tail.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return clean || "server";
}

/** SCREAMING_SNAKE env-var name guessed from a header's `{placeholder}` value,
 *  falling back to the header name. Only a suggestion — the founder sets it. */
function secretEnvName(header: { name?: string; value?: string }): string {
  const placeholder = header.value?.match(/\{([^}]+)\}/)?.[1];
  const base = placeholder ?? header.name ?? "MCP_TOKEN";
  return base.toUpperCase().replace(/[^A-Z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "MCP_TOKEN";
}

/** Pure map: one registry server → a suggestion with a runnable manifest entry. */
export function mapRegistryServer(server: RawRegistryServer): RegistrySuggestion {
  const name = server.name ?? "unknown";
  const base = { name, description: server.description ?? "", key: serverKey(name), requiredSecrets: [] as string[] };

  // Prefer a hosted remote (no local install).
  const remote = server.remotes?.find((r) => r.type === "streamable-http" || r.type === "http");
  if (remote?.url) {
    const headerEnv: Record<string, string> = {};
    const requiredSecrets: string[] = [];
    for (const h of remote.headers ?? []) {
      if (h.isSecret && h.name) {
        const envName = secretEnvName(h);
        headerEnv[h.name] = envName;
        requiredSecrets.push(envName);
      }
    }
    return {
      ...base,
      requiredSecrets,
      proposed: { transport: "http", url: remote.url, ...(requiredSecrets.length ? { headerEnv } : {}) },
    };
  }

  // Otherwise a runnable stdio package (uvx/npx). Docker/OCI is not auto-wired.
  const runnable = server.packages?.find(
    (p) => p.transport?.type === "stdio" && (p.runtimeHint === "uvx" || p.runtimeHint === "npx"),
  );
  if (runnable?.identifier) {
    const command = runnable.runtimeHint!;
    const args = command === "npx" ? ["-y", runnable.identifier] : [runnable.identifier];
    return { ...base, proposed: { transport: "stdio", command, args } };
  }

  const onlyDocker = server.packages?.some((p) => p.runtimeHint === "docker" || p.registryType === "oci");
  return {
    ...base,
    proposed: null,
    unsupported: onlyDocker ? "container-only (needs Docker) — not auto-wired" : "no http/uvx/npx transport advertised",
  };
}

/**
 * Search the registry and return normalized suggestions. Throws on a network or
 * HTTP error so the caller (the /connect handler) can surface it to the founder.
 */
export async function searchRegistry(query: string, limit = 5): Promise<RegistrySuggestion[]> {
  const url = `${REGISTRY_BASE}/v0/servers?search=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`registry ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { servers?: Array<{ server?: RawRegistryServer }> };
  const seen = new Set<string>();
  const out: RegistrySuggestion[] = [];
  for (const entry of body.servers ?? []) {
    if (!entry.server) continue;
    const s = mapRegistryServer(entry.server);
    if (seen.has(s.name)) continue; // registry lists every version; one row per name
    seen.add(s.name);
    out.push(s);
  }
  return out;
}

/** Finalize a proposed transport into a full, defaulted manifest entry for a
 *  chosen department (parsed through the schema so every field is populated). */
export function toManifestEntry(proposed: ProposedEntry, department: string): McpServerEntry {
  return mcpServerSchema.parse({ ...proposed, department });
}
