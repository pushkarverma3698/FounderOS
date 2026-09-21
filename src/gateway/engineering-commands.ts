/**
 * FounderOS — Engineering & Autonomous Agent Commands
 * ===================================================
 * Dedicated commands for the autonomous coding & PR loop:
 *   /repos    — list configured repositories and dispatch syntax
 *   /prs      — active pull requests across repos and review status
 *   /pipeline — live status of Antigravity and Claude pr-brain
 *   /help     — beginner-friendly quickstart guide
 */

import type { Context } from "grammy";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DISPATCH_REPO_ALLOWLIST } from "../tools/dispatch-repos.js";
import { safeHtml } from "./approval-card.js";
import { logger } from "../infra/logger.js";

const pExecFile = promisify(execFile);
const log = logger.child({ module: "engineering-commands" });

const REPO_DESCRIPTIONS: Record<string, string> = {
  "pushkarverma3698/FounderOS": "FounderOS Core (Autonomous agent kernel, telegram gateway, jobs pipeline)",
  "OplifyMessage/oplify-messaging-app": "Oplify App (Frontend, React Native, Mobile / Web app UI)",
  "OplifyMessage/oplify-messaging-api": "Oplify API (Backend, Node.js, Prisma, Redis, BullMQ, WebSockets)",
  "pushkarverma3698/House-of-Hulda-Website-frontend": "House of Hulda (Website frontend)",
};

async function queryGhJson<T>(args: string[]): Promise<T | null> {
  try {
    const { stdout } = await pExecFile("gh", args, {
      timeout: 10000,
      env: {
        ...process.env,
        GH_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
      },
    });
    return JSON.parse(stdout) as T;
  } catch (err) {
    log.warn({ args, err: String(err) }, "Failed to query gh CLI");
    return null;
  }
}

/** /repos — Show connected repositories and one-tap dispatch examples */
export async function handleRepos(ctx: Context): Promise<void> {
  const lines = [
    "📁 <b>Connected Repositories</b>",
    "FounderOS agents (Antigravity + Claude) can write and review code in these repositories:\n",
  ];

  for (const repo of DISPATCH_REPO_ALLOWLIST) {
    const desc = REPO_DESCRIPTIONS[repo] || "Repository";
    const shortName = repo.split("/")[1] || repo;
    lines.push(
      `🔹 <b>${safeHtml(repo)}</b>\n` +
      `<i>${safeHtml(desc)}</i>\n` +
      `👉 Tap to dispatch: <code>/task repo:${shortName} [instructions]</code>\n`
    );
  }

  lines.push(
    "💡 <b>Plain English works too!</b>\n" +
    "<i>“In oplify app, fix the socket connection”</i>\n" +
    "<i>“In oplify api, add a health check route”</i>\n" +
    "<i>“Fix the broken test in FounderOS”</i>"
  );

  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

interface GhPr {
  number: number;
  title: string;
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  url: string;
}

/** /prs — Active pull requests across all monitored repositories */
export async function handlePrs(ctx: Context): Promise<void> {
  await ctx.reply("🔍 Checking active Pull Requests across repositories...");

  const targetRepos = [
    "pushkarverma3698/FounderOS",
    "OplifyMessage/oplify-messaging-app",
    "OplifyMessage/oplify-messaging-api",
  ];

  const results: string[] = [];

  for (const repo of targetRepos) {
    const prs = await queryGhJson<GhPr[]>([
      "pr", "list",
      "--repo", repo,
      "--state", "open",
      "--limit", "5",
      "--json", "number,title,isDraft,baseRefName,headRefName,url",
    ]);

    if (prs && prs.length > 0) {
      results.push(`📦 <b>${safeHtml(repo)}</b>`);
      for (const pr of prs) {
        const badge = pr.isDraft ? "📝 [DRAFT / GATING]" : "✅ [READY]";
        results.push(
          `  • <b>#${pr.number}</b> ${badge} <b>${safeHtml(pr.title)}</b>\n` +
          `    Target: <code>${safeHtml(pr.baseRefName)}</code> ← <code>${safeHtml(pr.headRefName)}</code>\n` +
          `    🔗 <a href="${pr.url}">View on GitHub</a>`
        );
      }
      results.push("");
    }
  }

  if (results.length === 0) {
    await ctx.reply("✨ <b>No open PRs</b> across monitored repositories. All branches clean!", { parse_mode: "HTML" });
    return;
  }

  const header = "🚀 <b>Active Pull Requests & Review Status</b>\n\n";
  await ctx.reply(header + results.join("\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
}

interface GhIssue {
  number: number;
  title: string;
  labels: { name: string }[];
  url: string;
}

/** /pipeline — Live status of Antigravity Doer and Claude Reviewer */
export async function handlePipeline(ctx: Context): Promise<void> {
  const targetRepos = [
    "pushkarverma3698/FounderOS",
    "OplifyMessage/oplify-messaging-app",
    "OplifyMessage/oplify-messaging-api",
  ];

  const lines = [
    "⚡ <b>Autonomous Agent Pipeline Status</b>\n",
    "<b>Architecture:</b>",
    "• <b>Antigravity</b> (Doer) claims <code>agent:ready</code> issues and writes code",
    "• <b>Claude</b> (pr-brain) reviews & tests PRs every 20m, auto-merging when cleared\n",
    "<b>Current Active Queue:</b>",
  ];

  let totalActive = 0;

  for (const repo of targetRepos) {
    const issues = await queryGhJson<GhIssue[]>([
      "issue", "list",
      "--repo", repo,
      "--state", "open",
      "--limit", "10",
      "--json", "number,title,labels,url",
    ]);

    const activeInRepo = (issues || []).filter((iss) =>
      iss.labels.some((l) => l.name.startsWith("agent:"))
    );

    if (activeInRepo.length > 0) {
      totalActive += activeInRepo.length;
      lines.push(`\n📁 <b>${safeHtml(repo)}</b>:`);
      for (const iss of activeInRepo) {
        const stage = iss.labels.find((l) => l.name.startsWith("agent:"))?.name || "agent";
        let icon = "⏳";
        if (stage === "agent:working") icon = "🔨 [Antigravity coding]";
        else if (stage === "agent:review") icon = "🧠 [Claude reviewing]";
        else if (stage === "agent:ready") icon = "📥 [Queued]";
        else if (stage === "agent:blocked") icon = "🛑 [Needs human]";

        lines.push(`  • #${iss.number} ${icon}: ${safeHtml(iss.title)}`);
      }
    }
  }

  if (totalActive === 0) {
    lines.push("<i>No issues currently in the autonomous queue. Dispatcher is IDLE and ready for work!</i>");
  }

  lines.push("\n👉 Dispatch new work: <code>/task [what to build]</code>");
  await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
}

/** /help — Comprehensive beginner & pro guide */
export async function handleHelp(ctx: Context): Promise<void> {
  const guide = [
    "🌟 <b>FounderOS — Quickstart & Guide</b>",
    "Your autonomous multi-agent engineering & operations system.\n",
    "<b>How it works:</b>",
    "You tell FounderOS what you want in chat. The system automatically plans, writes code, reviews, and tests across your repositories.\n",
    "🚀 <b>Engineering (Autonomous Coding):</b>",
    "• <code>/task &lt;instruction&gt;</code> — Give coding tasks to Antigravity.",
    "  <i>Example: /task fix the flaky CSV export</i>",
    "• <code>/task repo:oplify-app &lt;instruction&gt;</code> — Work on Oplify.",
    "• <code>/repos</code> — See all connected GitHub repositories.",
    "• <code>/prs</code> — Check open Pull Requests and review status.",
    "• <code>/pipeline</code> — View real-time agent dispatch activity.\n",
    "🎯 <b>Jobs & Hiring:</b>",
    "• <code>/today</code> — Fresh job postings from the last 24 hours.",
    "• <code>/jobs</code> — Full ranked shortlist of screened jobs.",
    "• <code>/draft 1</code> — Tailor CV & cover letter PDF for role #1.",
    "• <code>/applied 1</code> — Mark role #1 as applied.\n",
    "⚙️ <b>System:</b>",
    "• <code>/status</code> — System health and integrations.",
    "• <code>/budget</code> — Daily spend and LLM caps.",
    "• <code>/commands</code> — Complete command reference.\n",
    "💬 <b>Plain English Always Works:</b>",
    "<i>You don't need to memorize slash commands. Try texting:</i>",
    "• <i>“In oplify api, check if redis connection pool is healthy”</i>",
    "• <i>“What are today's top software engineering jobs?”</i>",
    "• <i>“Summarise my recent emails”</i>",
  ];

  await ctx.reply(guide.join("\n"), { parse_mode: "HTML" });
}
