/**
 * FounderOS — LinkedIn via direct Posts API
 * ===========================================
 * Primary LinkedIn backend. Auth: founder OAuth token in env (admin-owned).
 * No Composio middleman. Post-only scope (ADR-009).
 */

import { childLogger } from "../logger.js";
import { readEnvValue } from "../credential-resolver.js";
import { getLinkedInAccount } from "../account-registry.js";
import type { ToolResult } from "../../tools/index.js";
import type { LinkedInPostInput } from "./types.js";

const log = childLogger({ module: "provider:linkedin-direct" });

const LINKEDIN_API_BASE = "https://api.linkedin.com/rest";
// LinkedIn versions the REST API monthly as YYYYMM and keeps each version active
// for ~1 year. A stale or malformed value is rejected with HTTP 426 ("Requested
// version … is not active") and silently kills every post. Keep this current.
const DEFAULT_API_VERSION = "202606";

/**
 * Resolve the LinkedIn-Version header value. Deterministic + defensive: a version
 * MUST be exactly six digits (YYYYMM). Anything else — an old dotted value like
 * "20240501", empty string, garbage — is IGNORED in favour of the known-good
 * default, so a bad env var can never 426 the whole posting path (prod 2026-07-04:
 * a leftover LINKEDIN_API_VERSION=20240501 in .env broke every post). Exported for
 * unit tests. */
export function resolveLinkedInApiVersion(raw: string | undefined): string {
  return raw && /^\d{6}$/.test(raw.trim()) ? raw.trim() : DEFAULT_API_VERSION;
}

/** Whether direct LinkedIn API credentials are configured (default/turicks account). */
export function linkedInDirectConfigured(): boolean {
  const token = readEnvValue("LINKEDIN_ACCESS_TOKEN");
  const urn = readEnvValue("LINKEDIN_AUTHOR_URN");
  return !!token && !!urn;
}

/** LinkedIn member/org URN — legacy global default. */
export function getLinkedInAuthorUrn(): string | undefined {
  return readEnvValue("LINKEDIN_AUTHOR_URN");
}

export function getLinkedInAccessToken(): string | undefined {
  return readEnvValue("LINKEDIN_ACCESS_TOKEN");
}

function getLinkedInApiVersion(): string {
  return resolveLinkedInApiVersion(readEnvValue("LINKEDIN_API_VERSION"));
}

async function linkedInCreds(input: { account_key?: string; department?: string }) {
  const { credentials, ctx } = await getLinkedInAccount({
    platform: "linkedin",
    account_key: input.account_key,
    department: input.department,
  });
  return { ...credentials, accountKey: ctx.account_key };
}

export async function directLinkedInPost(input: LinkedInPostInput): Promise<ToolResult> {
  const creds = await linkedInCreds(input);
  const token = creds.access_token;
  if (!token) {
    return {
      success: false,
      error:
        `LinkedIn access token not configured for account '${creds.accountKey}'. ` +
        "Set the token env var from the account registry runbook, or use LINKEDIN_BACKEND=composio.",
    };
  }

  const author = input.author_urn || creds.author_urn;
  if (!author) {
    return {
      success: false,
      error: `LinkedIn author URN not configured for account '${creds.accountKey}'. See ACCOUNT-REGISTRY-RUNBOOK.md.`,
    };
  }

  const body: Record<string, unknown> = {
    author,
    commentary: input.text,
    visibility: input.visibility === "CONNECTIONS" ? "CONNECTIONS" : "PUBLIC",
    distribution: { feedDistribution: "MAIN_FEED" },
    lifecycleState: "PUBLISHED",
  };

  if (input.image_url) {
    body["content"] = {
      media: { title: "image", id: input.image_url },
    };
  }

  if (input.schedule_time) {
    return {
      success: false,
      error:
        "Scheduled LinkedIn posts are not supported via the direct API adapter yet. Post immediately or use LINKEDIN_BACKEND=composio.",
    };
  }

  try {
    const res = await fetch(`${LINKEDIN_API_BASE}/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "LinkedIn-Version": getLinkedInApiVersion(),
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify(body),
    });

    const postId = res.headers.get("x-restli-id") ?? undefined;
    const raw = await res.text();
    let parsed: Record<string, unknown> | undefined;
    try {
      parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    } catch {
      parsed = undefined;
    }

    if (!res.ok) {
      const msg =
        (parsed?.["message"] as string | undefined) ??
        (parsed?.["errorDetail"] as string | undefined) ??
        raw.slice(0, 300) ??
        `LinkedIn API HTTP ${res.status}`;
      log.error({ status: res.status, err: msg }, "LinkedIn direct post failed");
      return { success: false, error: `LinkedIn API error (${res.status}): ${msg}` };
    }

    const resolvedId =
      postId ??
      (parsed?.["id"] as string | undefined) ??
      (parsed?.["x_restli_id"] as string | undefined);

    if (!resolvedId) {
      const msg = "LinkedIn post failed — no post id returned (check x-restli-id header)";
      log.error({ status: res.status, body: raw.slice(0, 200) }, "LinkedIn direct soft failure");
      return { success: false, error: msg };
    }

    const postUrl = `https://www.linkedin.com/feed/update/${resolvedId}`;
    log.info({ post_id: resolvedId, backend: "direct" }, "LinkedIn post published");
    return { success: true, data: { post_id: resolvedId, post_url: postUrl } };
  } catch (err) {
    const message = (err as Error).message;
    log.error({ err: message }, "LinkedIn direct post network error");
    return { success: false, error: message };
  }
}

export interface LinkedInComment {
  id: string;
  author_urn: string;
  text: string;
  created_at: number;
}

/**
 * Read comments on a LinkedIn post via the socialActions/comments sub-resource.
 * Requires r_member_social scope. Returns a clear 403 hint if scope is absent.
 */
export async function directLinkedInReadComments(
  postId: string,
  opts?: { limit?: number; account_key?: string; department?: string },
): Promise<import("../../tools/index.js").ToolResult> {
  const creds = await linkedInCreds(opts ?? {});
  const token = creds.access_token;
  if (!token) {
    return { success: false, error: "LINKEDIN_ACCESS_TOKEN not configured." };
  }

  try {
    const limit = opts?.limit ?? 20;
    const encoded = encodeURIComponent(postId);
    const res = await fetch(
      `${LINKEDIN_API_BASE}/socialActions/${encoded}/comments?count=${limit}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "LinkedIn-Version": getLinkedInApiVersion(),
          "X-Restli-Protocol-Version": "2.0.0",
        },
      },
    );

    if (res.status === 403) {
      return {
        success: false,
        error:
          "LinkedIn read access denied (403). Reading comments requires r_member_social scope. " +
          "Add this scope to your LinkedIn Developer App and re-authorize.",
      };
    }

    if (!res.ok) {
      const raw = await res.text();
      return {
        success: false,
        error: `LinkedIn comments API error (${res.status}): ${raw.slice(0, 200)}`,
      };
    }

    const data = (await res.json()) as {
      elements?: Array<{
        id?: string;
        actor?: string;
        message?: { text?: string };
        created?: { time?: number };
      }>;
      paging?: { total?: number };
    };

    const comments: LinkedInComment[] = (data.elements ?? []).map((el) => ({
      id: el.id ?? "",
      author_urn: el.actor ?? "",
      text: el.message?.text ?? "",
      created_at: el.created?.time ?? 0,
    }));

    log.info({ post_id: postId, count: comments.length }, "LinkedIn comments fetched");
    return {
      success: true,
      data: {
        post_id: postId,
        comments,
        total: data.paging?.total ?? comments.length,
      },
    };
  } catch (err) {
    const message = (err as Error).message;
    log.error({ err: message }, "LinkedIn comments fetch error");
    return { success: false, error: message };
  }
}

/**
 * Fetch the author's own recent posts via LinkedIn REST API.
 * Requires r_member_social scope — returns a clear 403 hint if absent.
 * The tool wrapper falls back to action_log when this 403s.
 */
export async function directLinkedInGetMyPosts(
  opts?: { limit?: number; account_key?: string; department?: string },
): Promise<ToolResult> {
  const creds = await linkedInCreds(opts ?? {});
  const token = creds.access_token;
  if (!token) return { success: false, error: "LINKEDIN_ACCESS_TOKEN not configured." };

  const author = creds.author_urn;
  if (!author) return { success: false, error: "LINKEDIN_AUTHOR_URN not configured." };

  try {
    const limit = opts?.limit ?? 5;
    const encoded = encodeURIComponent(author);
    const res = await fetch(
      `${LINKEDIN_API_BASE}/posts?author=${encoded}&q=author&count=${limit}&fields=id,commentary,created`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "LinkedIn-Version": getLinkedInApiVersion(),
          "X-Restli-Protocol-Version": "2.0.0",
        },
      },
    );

    if (res.status === 403) {
      return {
        success: false,
        error:
          "LinkedIn read access denied (403). Fetching your posts requires r_member_social scope. " +
          "Add this scope to your LinkedIn Developer App and re-authorize. " +
          "Falling back to FounderOS audit log for post IDs.",
      };
    }

    if (!res.ok) {
      const raw = await res.text();
      return { success: false, error: `LinkedIn posts API error (${res.status}): ${raw.slice(0, 200)}` };
    }

    const data = (await res.json()) as {
      elements?: Array<{ id?: string; commentary?: string; created?: { time?: number } }>;
    };

    const posts = (data.elements ?? []).map((el) => ({
      id: el.id ?? "",
      text: el.commentary ?? "",
      created_at: el.created?.time ?? 0,
    }));

    log.info({ count: posts.length, author }, "LinkedIn own posts fetched");
    return { success: true, data: { posts } };
  } catch (err) {
    const message = (err as Error).message;
    log.error({ err: message }, "LinkedIn get-my-posts network error");
    return { success: false, error: message };
  }
}

/** Read-only analytics — best-effort via direct API (may require extra scopes). */
export async function directLinkedInAnalytics(
  postId: string,
  opts?: { account_key?: string; department?: string },
): Promise<ToolResult> {
  const creds = await linkedInCreds(opts ?? {});
  const token = creds.access_token;
  if (!token) {
    return { success: false, error: "LINKEDIN_ACCESS_TOKEN not configured." };
  }

  try {
    const encoded = encodeURIComponent(postId);
    const res = await fetch(`${LINKEDIN_API_BASE}/socialActions/${encoded}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        "LinkedIn-Version": getLinkedInApiVersion(),
        "X-Restli-Protocol-Version": "2.0.0",
      },
    });

    if (!res.ok) {
      const raw = await res.text();
      return {
        success: false,
        error: `LinkedIn analytics unavailable (${res.status}): ${raw.slice(0, 200)}`,
      };
    }

    const data = (await res.json()) as Record<string, unknown>;
    return { success: true, data };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}
