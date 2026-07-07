/**
 * Deterministic GitHub write HITL fast path — direct github_write invoke in a
 * one-node graph, same pattern as shell-hitl-fast-path.ts and
 * github-read-fast-path.ts (rule #16).
 *
 * Root cause this closes: buildOfficeInput() only ever injects an advisory
 * [ROUTING DIRECTIVE: ...] system message — the LLM supervisor/department is
 * free to ignore it and refuse the write outright (T13: classifier said
 * engineering, model said "I can't do that"). This removes the LLM from the
 * decision to call github_write at all for unambiguous, structured requests;
 * everything else falls through to the existing office routing unchanged.
 *
 * Only fast-paths when owner/repo/title (as required by the target action —
 * see missingGithubWriteFields) can be extracted with high confidence from an
 * explicit marker ("titled ...", "title: ..."). There is no reliable way to
 * lift a title out of arbitrary free text, so ambiguous phrasing intentionally
 * returns null and defers to the office/LLM rather than risk a garbage title.
 */

import { Annotation, StateGraph, START, END, Command } from "@langchain/langgraph";
import type { BaseCheckpointSaver, CompiledStateGraph } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import { githubWrite, missingGithubWriteFields } from "../agents/agent-tools/engineering.js";
import { getPendingApproval } from "../agents/office.js";
import { getCheckpointer } from "../infra/checkpointer.js";
import { isGithubWriteRequest } from "./execution-guard.js";
import { parseGithubOwnerRepo } from "./github-read-fast-path.js";

const GITHUB_WRITE_FP_SUFFIX = ":github-write-fp";

export type GithubWriteAction = "create_issue" | "create_repo" | "update_readme";

export interface GithubWriteParams {
  action: GithubWriteAction;
  owner?: string;
  repo?: string;
  title?: string;
  body?: string;
  content?: string;
}

const GithubWriteState = Annotation.Root({
  action: Annotation<GithubWriteAction>,
  owner: Annotation<string | undefined>,
  repo: Annotation<string | undefined>,
  title: Annotation<string | undefined>,
  body: Annotation<string | undefined>,
  content: Annotation<string | undefined>,
  output: Annotation<string>,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _githubWriteHitlGraph: CompiledStateGraph<any, any, any> | undefined;

export function githubWriteFastPathThreadId(baseThreadId: string): string {
  return `${baseThreadId}${GITHUB_WRITE_FP_SUFFIX}`;
}

export function isGithubWriteFastPathThread(threadId: string): boolean {
  return threadId.endsWith(GITHUB_WRITE_FP_SUFFIX);
}

export function buildGithubWriteHitlGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(GithubWriteState)
    .addNode("write", async (state, config) => {
      const result = await githubWrite.invoke(
        {
          action: state.action,
          owner: state.owner ?? null,
          repo: state.repo ?? null,
          title: state.title ?? null,
          body: state.body ?? null,
          content: state.content ?? null,
        },
        config,
      );
      const output = typeof result === "string" ? result : String(result);
      return { output };
    })
    .addEdge(START, "write")
    .addEdge("write", END)
    .compile({ checkpointer }) as unknown as CompiledStateGraph<any, any, any>;
}

async function getGithubWriteHitlGraph(): Promise<CompiledStateGraph<any, any, any>> {
  if (!_githubWriteHitlGraph) {
    const checkpointer = await getCheckpointer();
    _githubWriteHitlGraph = buildGithubWriteHitlGraph(checkpointer as unknown as BaseCheckpointSaver);
  }
  return _githubWriteHitlGraph;
}

function detectGithubWriteAction(input: string): GithubWriteAction {
  if (/\breadme\b/i.test(input)) return "update_readme";
  if (/\brepo(sitory)?\b/i.test(input) && !/\b(issue|pull request|pr)\b/i.test(input)) return "create_repo";
  return "create_issue";
}

const TITLE_MARKER_RE = /\btitle[d]?\s*[:\-]?\s*["'“]([^"'”]{1,200})["'”]|\btitle[d]?\s*:\s*([^\n.?!]{1,200})/i;
const BODY_MARKER_RE = /\bbody\s*[:\-]?\s*["'“]([^"'”]{1,2000})["'”]|\bbody\s*:\s*([^\n]{1,2000})/i;

/**
 * A prior step (research/search/read) must run BEFORE the write, and its
 * output is what belongs in the body/content (e.g. T13: "Research X, then
 * create a GitHub issue... with those findings in the body"). Without an
 * explicit body marker in the text, fast-pathing here would create the issue
 * with an EMPTY body and skip the research step entirely — worse than the
 * refusal bug this file exists to fix. Bail and let office routing run the
 * chain for real; github_write is still HITL-gated when it gets there.
 */
const RESEARCH_CHAIN_RE = /\b(research|investigate|find out|look up|look into|search (?:the web|online|for))\b/i;

/**
 * Extract structured github_write params from free text. Returns null when the
 * request isn't an unambiguous, explicitly-marked write (deliberately
 * conservative — see module docstring).
 */
export function extractGithubWriteParams(input: string): GithubWriteParams | null {
  if (!isGithubWriteRequest(input)) return null;

  const action = detectGithubWriteAction(input);
  const pair = parseGithubOwnerRepo(input);
  const titleMatch = input.match(TITLE_MARKER_RE);
  const title = (titleMatch?.[1] ?? titleMatch?.[2])?.trim();
  const bodyMatch = input.match(BODY_MARKER_RE);
  const body = (bodyMatch?.[1] ?? bodyMatch?.[2])?.trim();

  // Multi-step chain (research/search must run first to produce the body) —
  // defer to office routing rather than fast-path an empty-body write.
  if (!body && RESEARCH_CHAIN_RE.test(input)) return null;

  const params: GithubWriteParams = {
    action,
    owner: pair?.owner,
    repo: pair?.repo,
    title,
    body,
    content: action === "update_readme" ? body : undefined,
  };

  const missing = missingGithubWriteFields(action, {
    owner: params.owner,
    repo: params.repo,
    title: params.title,
    content: params.content,
  });
  if (missing.length > 0) return null;

  return params;
}

export function githubWriteFastPathConfig(baseConfig: RunnableConfig): RunnableConfig {
  const threadId = String(baseConfig.configurable?.["thread_id"] ?? "default");
  return {
    ...baseConfig,
    configurable: {
      ...baseConfig.configurable,
      thread_id: githubWriteFastPathThreadId(threadId),
    },
  };
}

/**
 * Invoke deterministic github_write HITL graph. Returns true when an
 * approval interrupt is pending, false when the text isn't a confidently
 * parseable write request (caller should fall through to office routing).
 */
export async function invokeGithubWriteFastPath(
  config: RunnableConfig,
  text: string,
): Promise<boolean> {
  const params = extractGithubWriteParams(text);
  if (!params) return false;

  const graph = await getGithubWriteHitlGraph();
  const ghConfig = githubWriteFastPathConfig(config);
  await graph.invoke(
    {
      action: params.action,
      owner: params.owner,
      repo: params.repo,
      title: params.title,
      body: params.body,
      content: params.content,
    },
    ghConfig,
  );
  const approval = await getPendingApproval(graph, ghConfig);
  return approval !== null;
}

export async function getGithubWriteHitlPendingApproval(
  config: RunnableConfig,
): Promise<Awaited<ReturnType<typeof getPendingApproval>>> {
  const graph = await getGithubWriteHitlGraph();
  return getPendingApproval(graph, githubWriteFastPathConfig(config));
}

export async function resumeGithubWriteFastPath(
  config: RunnableConfig,
  decision: "approved" | "rejected",
): Promise<{ output?: string }> {
  const graph = await getGithubWriteHitlGraph();
  const ghConfig = githubWriteFastPathConfig(config);
  return graph.invoke(new Command({ resume: decision }), ghConfig) as Promise<{ output?: string }>;
}

/** Reset singleton (tests). */
export function resetGithubWriteFastPathForTests(): void {
  _githubWriteHitlGraph = undefined;
}
