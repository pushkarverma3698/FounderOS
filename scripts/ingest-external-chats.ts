/**
 * FounderOS — Mass Chat Ingestion Script (ChatGPT, Claude, Gemini)
 * =================================================================
 * Ingests exported chat histories (conversations.json from OpenAI/Claude,
 * or Gemini export JSON files) into brain.turicks_brain pgvector store.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/ingest-external-chats.ts <path-to-export-dir-or-file>
 */

import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { getDb } from "../src/db/client.js";
import { sql } from "drizzle-orm";
import { embedTexts, chunkText } from "../src/lib/embed.js";

interface ChatMessage {
  role: string;
  text: string;
}

interface ChatConversation {
  title: string;
  create_time?: number;
  messages: ChatMessage[];
}

function parseOpenAiExport(jsonText: string): ChatConversation[] {
  const conversations: ChatConversation[] = [];
  try {
    const raw = JSON.parse(jsonText);
    const list = Array.isArray(raw) ? raw : [raw];

    for (const item of list) {
      const title = item.title ?? "Untitled ChatGPT Conversation";
      const createTime = item.create_time;
      const messages: ChatMessage[] = [];

      if (item.mapping && typeof item.mapping === "object") {
        for (const node of Object.values(item.mapping as Record<string, any>)) {
          const msg = node?.message;
          if (!msg || !msg.content || !msg.content.parts) continue;
          const role = msg.author?.role ?? "unknown";
          const textParts = msg.content.parts.filter((p: unknown) => typeof p === "string");
          const text = textParts.join("\n").trim();
          if (text.length > 5) {
            messages.push({ role, text });
          }
        }
      }
      if (messages.length > 0) {
        conversations.push({ title, create_time: createTime, messages });
      }
    }
  } catch (err) {
    console.warn("Could not parse as OpenAI export:", (err as Error).message);
  }
  return conversations;
}

function parseClaudeExport(jsonText: string): ChatConversation[] {
  const conversations: ChatConversation[] = [];
  try {
    const raw = JSON.parse(jsonText);
    const list = Array.isArray(raw) ? raw : [raw];

    for (const item of list) {
      const title = item.name ?? item.title ?? "Untitled Claude Conversation";
      const messages: ChatMessage[] = [];

      const chatMsgs = item.chat_messages ?? item.messages;
      if (Array.isArray(chatMsgs)) {
        for (const m of chatMsgs) {
          const role = m.sender ?? m.role ?? "unknown";
          const text = typeof m.text === "string" ? m.text : JSON.stringify(m.text ?? "");
          if (text.length > 5) messages.push({ role, text });
        }
      }
      if (messages.length > 0) conversations.push({ title, messages });
    }
  } catch (err) {
    console.warn("Could not parse as Claude export:", (err as Error).message);
  }
  return conversations;
}

export async function ingestChatExport(targetPath: string): Promise<number> {
  if (!existsSync(targetPath)) {
    throw new Error(`Target path does not exist: ${targetPath}`);
  }

  const files: string[] = [];
  const stat = statSync(targetPath);
  if (stat.isDirectory()) {
    for (const f of readdirSync(targetPath)) {
      if (extname(f) === ".json") files.push(join(targetPath, f));
    }
  } else {
    files.push(targetPath);
  }

  let totalConversations = 0;
  const db = getDb();

  for (const filePath of files) {
    console.log(`Processing ${filePath}...`);
    const rawText = readFileSync(filePath, "utf-8");

    let convs = parseOpenAiExport(rawText);
    if (convs.length === 0) convs = parseClaudeExport(rawText);

    console.log(`Found ${convs.length} conversations in ${filePath}`);

    for (const conv of convs) {
      const formattedText = [
        `# ${conv.title}`,
        ...conv.messages.map((m) => `**${m.role.toUpperCase()}**: ${m.text}`),
      ].join("\n\n");

      const chunks = chunkText(formattedText, 1000);
      let embeddings: number[][] = [];
      try {
        embeddings = await embedTexts(chunks);
      } catch {
        embeddings = chunks.map(() => []); // graceful fallback
      }

      const source = `chat-export:${conv.title.slice(0, 40)}`;

      await db.execute(sql`
        DELETE FROM brain.turicks_brain WHERE metadata->>'source' = ${source};
      `);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const embArr = embeddings[i];
        const emb = embArr && embArr.length > 0 ? `[${embArr.join(",")}]` : null;
        const meta = JSON.stringify({
          source,
          doc_type: "external_chat_export",
          title: conv.title,
          chunk_index: i,
          total_chunks: chunks.length,
          updated_at: new Date().toISOString(),
        });

        if (emb) {
          await db.execute(sql`
            INSERT INTO brain.turicks_brain (content, metadata, embedding)
            VALUES (${chunk}, ${meta}::jsonb, ${emb}::vector);
          `);
        } else {
          await db.execute(sql`
            INSERT INTO brain.turicks_brain (content, metadata)
            VALUES (${chunk}, ${meta}::jsonb);
          `);
        }
      }

      totalConversations++;
    }
  }

  return totalConversations;
}

async function main(): Promise<void> {
  const target = process.argv[2];
  if (!target) {
    console.log("Usage: npx tsx --env-file=.env scripts/ingest-external-chats.ts <path-to-json-export-or-dir>");
    process.exit(0);
  }
  const count = await ingestChatExport(target);
  console.log(`Successfully ingested ${count} chat conversations into turicks_brain pgvector store!`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("Chat ingestion failed:", e);
    process.exit(1);
  });
}
