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

const msgs: ChatMessage[] = JSON.parse(readFileSync("/tmp/telegram_chat_dump.json", "utf-8"));
console.log(`Loaded ${msgs.length} messages.`);

const botMsgs = msgs.filter((m) => !m.out);
const userMsgs = msgs.filter((m) => m.out);

const findings: {
  category: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  title: string;
  count: number;
  sampleMsgIds: number[];
  details: string;
  samples: Array<{ id: number; date: string; text: string }>;
}[] = [];

// 1. Spammed repeating messages (Frequency analysis)
const textFrequency = new Map<string, { count: number; msgs: ChatMessage[] }>();
for (const m of botMsgs) {
  // Normalize text slightly to catch template repeats
  let norm = m.text.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z\b/g, "<TIMESTAMP>");
  norm = norm.replace(/#\d+/g, "<ID>");
  norm = norm.replace(/\d+ candidates/g, "<N> candidates");
  norm = norm.replace(/\d+ sweeps/g, "<N> sweeps");
  norm = norm.trim();

  if (!textFrequency.has(norm)) {
    textFrequency.set(norm, { count: 0, msgs: [] });
  }
  const entry = textFrequency.get(norm)!;
  entry.count++;
  entry.msgs.push(m);
}

for (const [norm, data] of textFrequency.entries()) {
  if (data.count >= 10 && norm.length > 20) {
    let severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" = "MEDIUM";
    if (norm.includes("auth expired") || norm.includes("STOPPED")) severity = "HIGH";
    if (norm.includes("funnel alert")) severity = "HIGH";

    findings.push({
      category: "Repeating Notification / Spam Loop",
      severity,
      title: `Message repeated ${data.count} times`,
      count: data.count,
      sampleMsgIds: data.msgs.slice(0, 5).map((m) => m.id),
      details: `This exact message pattern appeared ${data.count} times in the chat, cluttering the founder channel.`,
      samples: data.msgs.slice(0, 3).map((m) => ({ id: m.id, date: m.date, text: m.text.slice(0, 300) })),
    });
  }
}

// 2. Truncated Messages
const truncatedMsgs: ChatMessage[] = [];
for (const m of botMsgs) {
  const t = m.text.trim();
  if (t.endsWith("…") || t.endsWith("...") || t.endsWith("1. Pe") || t.endsWith("witho") || t.endsWith("approx")) {
    truncatedMsgs.push(m);
  }
}
if (truncatedMsgs.length > 0) {
  findings.push({
    category: "Message Truncation / Drop",
    severity: "HIGH",
    title: `Bot messages cut off abruptly (${truncatedMsgs.length} occurrences)`,
    count: truncatedMsgs.length,
    sampleMsgIds: truncatedMsgs.slice(0, 5).map((m) => m.id),
    details: `The bot output was cut off mid-sentence with ellipsis or sliced at 4000/1500 chars without streaming continuation chunks.`,
    samples: truncatedMsgs.slice(-5).map((m) => ({ id: m.id, date: m.date, text: m.text.slice(-200) })),
  });
}

// 3. Unrendered LaTeX Math Tokens
const latexMsgs = botMsgs.filter((m) => m.text.includes("$$") || m.text.includes("\\frac") || m.text.includes("\\approx") || m.text.includes("\\times") || m.text.includes("\\sim"));
if (latexMsgs.length > 0) {
  findings.push({
    category: "Formatting / Unrendered LaTeX",
    severity: "MEDIUM",
    title: `Unrendered LaTeX mathematical syntax shown as raw text (${latexMsgs.length} messages)`,
    count: latexMsgs.length,
    sampleMsgIds: latexMsgs.slice(0, 5).map((m) => m.id),
    details: `Telegram client does not render LaTeX ($$...$$, \\frac, etc.). The bot sends raw mathematical formatting which renders as broken code like '$$ ext{Duration} =  rac{13,000}{21.2} approx 613' to the user.`,
    samples: latexMsgs.slice(0, 3).map((m) => ({ id: m.id, date: m.date, text: m.text.slice(0, 300) })),
  });
}

// 4. System Exceptions / Leaked Errors
const errorMsgs = botMsgs.filter((m) =>
  m.text.includes("❌ <b>Error</b>") ||
  m.text.includes("Unhandled bot error") ||
  m.text.includes("TypeError:") ||
  m.text.includes("ReferenceError:") ||
  m.text.includes("ECONNREFUSED") ||
  m.text.includes("Crash caught") ||
  m.text.includes("Telegram API error") ||
  m.text.includes("Scheduled task dropped")
);
if (errorMsgs.length > 0) {
  findings.push({
    category: "Crash / Leaked Internal Exceptions",
    severity: "HIGH",
    title: `Internal exceptions and crash notices sent to chat (${errorMsgs.length} messages)`,
    count: errorMsgs.length,
    sampleMsgIds: errorMsgs.slice(0, 5).map((m) => m.id),
    details: `System errors, dropped scheduled tasks, and uncaught exceptions leaked directly into user chat.`,
    samples: errorMsgs.slice(0, 5).map((m) => ({ id: m.id, date: m.date, text: m.text.slice(0, 300) })),
  });
}

// 5. Unknown Command Replies
const unknownCmdMsgs = botMsgs.filter((m) => m.text.includes("Unknown command") || m.text.includes("did not exist"));
if (unknownCmdMsgs.length > 0) {
  findings.push({
    category: "Command Handling / Dead Commands",
    severity: "MEDIUM",
    title: `Unknown command errors triggered by founder (${unknownCmdMsgs.length} messages)`,
    count: unknownCmdMsgs.length,
    sampleMsgIds: unknownCmdMsgs.slice(0, 5).map((m) => m.id),
    details: `The founder attempted commands that failed or were unregistered.`,
    samples: unknownCmdMsgs.slice(0, 5).map((m) => ({ id: m.id, date: m.date, text: m.text.slice(0, 300) })),
  });
}

// 6. Autolink Glitches on Filenames and Code
const filenameAutolinks: Array<{ id: number; date: string; url: string; text: string }> = [];
for (const m of botMsgs) {
  for (const u of m.urls) {
    if (u.url.match(/\.(md|py|sh|ts|js|json|yml|yaml|png|jpg|pdf)$/i) && !u.url.startsWith("http")) {
      filenameAutolinks.push({ id: m.id, date: m.date, url: u.url, text: m.text.slice(0, 100) });
    }
  }
}
if (filenameAutolinks.length > 0) {
  findings.push({
    category: "Autolink Glitch / Dead Pseudo-Links",
    severity: "MEDIUM",
    title: `Filenames without code formatting turned into dead clickable links (${filenameAutolinks.length} occurrences)`,
    count: filenameAutolinks.length,
    sampleMsgIds: filenameAutolinks.slice(0, 5).map((f) => f.id),
    details: `Filenames like README.md, BRAND.md, primes.py, etc. were sent in plain text rather than \`code\` backticks. Telegram parses .md (Moldova) and .py (Paraguay) as TLDs and turns them into dead hyperlinks that fail to open when tapped by the founder.`,
    samples: filenameAutolinks.slice(0, 5).map((f) => ({ id: f.id, date: f.date, text: `Link: ${f.url} | Message: ${f.text}` })),
  });
}

// 7. Stale / Repeated Job Batches
const jobAlerts = botMsgs.filter((m) => m.text.includes("jobs ready to apply") || m.text.includes("🎯"));
const jobCounts = new Map<string, number>();
for (const j of jobAlerts) {
  const match = j.text.match(/🎯\s+(\d+)\s+jobs ready to apply/);
  if (match) {
    const key = match[1];
    if (key) {
      jobCounts.set(key, (jobCounts.get(key) || 0) + 1);
    }
  }
}
findings.push({
  category: "Job Pipeline / Repeated Alerts",
  severity: "MEDIUM",
  title: `Job notification batches sent repeatedly (${jobAlerts.length} messages)`,
  count: jobAlerts.length,
  sampleMsgIds: jobAlerts.slice(0, 5).map((m) => m.id),
  details: `The bot repeatedly alerts the user about the same ready-to-apply jobs (e.g. '39 jobs ready to apply') on every cycle without diffing what is already sent or seen.`,
  samples: jobAlerts.slice(-3).map((m) => ({ id: m.id, date: m.date, text: m.text.slice(0, 300) })),
});

// 8. Turn Latency & Slow Replies
const turnLatencies: Array<{ userId: number; botId: number; latencySec: number; userText: string; botText: string }> = [];
for (let i = 0; i < msgs.length - 1; i++) {
  const cur = msgs[i];
  const next = msgs[i + 1];
  if (cur && next && cur.out && !next.out) {
    const userTime = new Date(cur.date).getTime();
    const botTime = new Date(next.date).getTime();
    const sec = Math.round((botTime - userTime) / 1000);
    if (sec > 60) {
      turnLatencies.push({
        userId: cur.id,
        botId: next.id,
        latencySec: sec,
        userText: cur.text.slice(0, 60),
        botText: next.text.slice(0, 60),
      });
    }
  }
}
if (turnLatencies.length > 0) {
  findings.push({
    category: "Performance / High Latency",
    severity: "LOW",
    title: `Slow bot response times > 60s (${turnLatencies.length} turns)`,
    count: turnLatencies.length,
    sampleMsgIds: turnLatencies.slice(0, 5).map((t) => t.botId),
    details: `User turns where response took more than 60 seconds (max latency: ${Math.max(...turnLatencies.map((t) => t.latencySec))}s).`,
    samples: turnLatencies.slice(-5).map((t) => ({ id: t.botId, date: "", text: `Latency: ${t.latencySec}s | User: "${t.userText}"` })),
  });
}

writeFileSync("/tmp/telegram_deep_bug_findings.json", JSON.stringify(findings, null, 2));
console.log(`Generated ${findings.length} categories of findings.`);
