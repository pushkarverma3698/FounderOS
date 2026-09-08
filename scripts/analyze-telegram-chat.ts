/**
 * Telegram Chat Audit & Link Verification Script
 * Analyzes dumped Telegram chat messages:
 * - Checks all URLs provided by the bot (status code, reachability, dead links)
 * - Identifies bot bugs, truncation, repeating spam, error replies, and anomalies.
 */

import { readFileSync, writeFileSync } from "node:fs";

interface MsgUrl {
  type: string;
  url: string;
  label?: string;
}

interface ChatMessage {
  id: number;
  date: string;
  out: boolean;
  text: string;
  urls: MsgUrl[];
  hasMedia: boolean;
  mediaType: string | null;
  buttons: string[];
}

interface LinkCheckResult {
  msgId: number;
  date: string;
  url: string;
  label?: string;
  status: number | string;
  ok: boolean;
  finalUrl?: string;
  error?: string;
  pageIssue?: string;
}

async function checkUrl(url: string): Promise<{ status: number | string; ok: boolean; finalUrl?: string; error?: string; pageIssue?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);

    const status = res.status;
    const finalUrl = res.url;
    let pageIssue: string | undefined;

    if (status >= 400) {
      return { status, ok: false, finalUrl, error: `HTTP ${status}` };
    }

    // Check page content for soft-404s (e.g. job closed)
    try {
      const text = (await res.text()).slice(0, 50000).toLowerCase();
      if (text.includes("this job has been closed") ||
          text.includes("this job is no longer available") ||
          text.includes("job posting has expired") ||
          text.includes("no longer accepting applications") ||
          text.includes("page not found") ||
          text.includes("job not found") ||
          text.includes("position is closed") ||
          text.includes("404 not found") ||
          text.includes("does not exist")) {
        pageIssue = "Soft 404 / Job closed or page not found";
      }
    } catch {
      // ignore reading error
    }

    return { status, ok: true, finalUrl, pageIssue };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { status: "ERROR", ok: false, error: errorMsg };
  }
}

async function main() {
  const dumpPath = process.argv[2] ?? "/tmp/telegram_chat_dump.json";
  console.log(`Loading dump from ${dumpPath}...`);
  const raw = readFileSync(dumpPath, "utf-8");
  const messages: ChatMessage[] = JSON.parse(raw);
  console.log(`Loaded ${messages.length} messages.`);

  // Filter bot messages
  const botMessages = messages.filter((m) => !m.out);
  const userMessages = messages.filter((m) => m.out);
  console.log(`Bot messages: ${botMessages.length}, User messages: ${userMessages.length}`);

  // Collect all URLs provided to the user
  const linksToCheck: Array<{ msgId: number; date: string; url: string; label?: string; context: string }> = [];
  for (const m of botMessages) {
    for (const u of m.urls) {
      linksToCheck.push({
        msgId: m.id,
        date: m.date,
        url: u.url,
        label: u.label,
        context: m.text.slice(0, 120),
      });
    }
  }

  console.log(`\nFound ${linksToCheck.length} links provided by the bot. Checking reachability (concurrency: 10)...`);

  const linkResults: LinkCheckResult[] = [];
  const CONCURRENCY = 10;
  for (let i = 0; i < linksToCheck.length; i += CONCURRENCY) {
    const chunk = linksToCheck.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (item) => {
        const res = await checkUrl(item.url);
        return {
          msgId: item.msgId,
          date: item.date,
          url: item.url,
          label: item.label,
          status: res.status,
          ok: res.ok,
          finalUrl: res.finalUrl,
          error: res.error,
          pageIssue: res.pageIssue,
        };
      })
    );
    linkResults.push(...results);
    process.stdout.write(`Checked ${linkResults.length}/${linksToCheck.length} links...\r`);
  }

  console.log("\nLink check completed!");

  // Analyze dead links
  const deadLinks = linkResults.filter((r) => !r.ok || r.pageIssue);
  console.log(`Dead / Problematic links: ${deadLinks.length} / ${linkResults.length}`);

  // ── Bug Auditing in Chat ──────────────────────────────────────────────────────
  console.log("\nAuditing chat messages for bugs & anomalies...");

  const bugsFound: Array<{
    category: string;
    msgId: number;
    date: string;
    description: string;
    snippet: string;
  }> = [];

  // 1. Truncation bugs (text ends with … or cuts off mid-sentence)
  for (const m of botMessages) {
    const trimmed = m.text.trim();
    if (trimmed.endsWith("…") || trimmed.endsWith("...") || trimmed.endsWith("1. Pe") || trimmed.endsWith("witho")) {
      bugsFound.push({
        category: "Message Truncation",
        msgId: m.id,
        date: m.date,
        description: "Bot response was truncated mid-sentence or cut off with ellipsis without sending continuation chunks.",
        snippet: trimmed.slice(-150),
      });
    }
  }

  // 2. Repeating spam alerts (pr-brain auth expired, repeating job counts)
  let prBrainCount = 0;
  const prBrainMsgs: number[] = [];
  for (const m of botMessages) {
    if (m.text.includes("pr-brain STOPPED on founder-os: Claude Code auth expired")) {
      prBrainCount++;
      prBrainMsgs.push(m.id);
    }
  }
  if (prBrainCount > 1) {
    bugsFound.push({
      category: "Spam / Notification Flapping",
      msgId: prBrainMsgs[0] ?? 0,
      date: botMessages.find((m) => m.id === prBrainMsgs[0])?.date ?? "",
      description: `Claude Code auth expired message repeated ${prBrainCount} times across the chat history! Flooding the founder's Telegram.`,
      snippet: `pr-brain STOPPED on founder-os: Claude Code auth expired (repeated ${prBrainCount} times)`,
    });
  }

  // 3. Funnel alert spam & false alerts
  for (const m of botMessages) {
    if (m.text.includes("Job lane funnel alert")) {
      bugsFound.push({
        category: "Funnel Alert Noise",
        msgId: m.id,
        date: m.date,
        description: "Funnel alert triggered in Telegram chat.",
        snippet: m.text.slice(0, 200),
      });
    }
  }

  // 4. Unhandled crashes / errors / raw exception messages
  for (const m of botMessages) {
    if (m.text.includes("Error:") || m.text.includes("Unhandled bot error") || m.text.includes("Internal error") || m.text.includes("TypeError") || m.text.includes("ReferenceError") || m.text.includes("ECONNREFUSED") || m.text.includes("failed with status")) {
      bugsFound.push({
        category: "Unhandled Error / Exception Leak",
        msgId: m.id,
        date: m.date,
        description: "Bot leaked an error / exception / HTTP failure to founder.",
        snippet: m.text.slice(0, 250),
      });
    }
  }

  // 5. Unknown command replies
  for (const m of botMessages) {
    if (m.text.includes("Unknown command") || m.text.includes("did not exist") || m.text.includes("unrecognized command")) {
      bugsFound.push({
        category: "Unknown Command",
        msgId: m.id,
        date: m.date,
        description: "Founder attempted a command that was unrecognized.",
        snippet: m.text.slice(0, 200),
      });
    }
  }

  // 6. Broken formatting: raw LaTeX or broken HTML entities
  for (const m of botMessages) {
    if (m.text.includes("$$") || m.text.includes("\\(") || m.text.includes("\\frac") || m.text.includes("\\approx") || m.text.includes("&amp;") || m.text.includes("&lt;")) {
      bugsFound.push({
        category: "Broken Formatting / Unrendered LaTeX or Entities",
        msgId: m.id,
        date: m.date,
        description: "Bot output contains unrendered LaTeX markup ($$ or \\frac) or raw HTML entities that look ugly or broken in Telegram.",
        snippet: m.text.slice(0, 200),
      });
    }
  }

  // Summary output
  const report = {
    totalMessages: messages.length,
    botMessages: botMessages.length,
    userMessages: userMessages.length,
    totalLinksChecked: linkResults.length,
    deadLinksCount: deadLinks.length,
    deadLinks,
    totalBugsIdentified: bugsFound.length,
    bugsFound,
  };

  writeFileSync("/tmp/telegram_chat_audit_report.json", JSON.stringify(report, null, 2));
  console.log("\nAudit complete! Report saved to /tmp/telegram_chat_audit_report.json");
}

main().catch(console.error);
