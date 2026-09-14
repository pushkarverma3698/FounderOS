/**
 * Engineering department tool — start a new project repository.
 * HITL-gated: the founder approves the name and visibility before anything is created.
 *
 * The approval card is the security boundary for the dispatch registry, so it has to
 * say plainly what approving means: a real repository under his own account, and one
 * the unattended agent loop may thereafter write to without asking again. A card that
 * only said "create repo?" would understate the second half.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { createProjectRepoTool, validateProjectRepoName } from "../../tools/create-project-repo.js";
import { childLogger } from "../../infra/logger.js";
import { hitlGate, idemKey } from "./hitl.js";
import { writeAuditEntry } from "../../db/queries.js";
import { TENANT } from "../../core/config.js";

const log = childLogger({ module: "agent-tools:project-repo" });

export const createProjectRepo = tool(
  async ({ name, description, isPrivate }, config) => {
    // Validate above the gate. This is pure and re-runnable, which everything above
    // hitlGate must be — the tool runs again from the top when the founder approves.
    const invalid = validateProjectRepoName(name);
    if (invalid) return `❌ Cannot create that repository: ${invalid}`;

    const visibility = isPrivate === false ? "PUBLIC" : "private";
    const key = idemKey("create_project_repo", name.trim().toLowerCase());

    const rejected = await hitlGate(
      {
        action: "create_project_repo",
        title: "📦 Start a new project repository?",
        summary: `Create ${visibility} repo "${name.trim()}" and allow the agent loop to work in it`,
        preview: [
          `Repository: pushkarverma3698/${name.trim()}`,
          `Visibility: ${visibility}`,
          description ? `Description: ${description}` : "Description: (none)",
          "",
          "Approving also registers this repo as a target Antigravity may be dispatched",
          "to. It still needs a checkout on the VPS before the loop can run there — the",
          "exact commands come back with the result.",
        ].join("\n"),
        args: { name, description, isPrivate },
      },
      config,
    );
    if (rejected) return rejected;

    const res = await createProjectRepoTool.execute({
      name,
      ...(description ? { description } : {}),
      ...(isPrivate === false ? { isPrivate: false } : {}),
    });

    if (!res.success) {
      log.error({ name, error: res.error }, "createProjectRepo failed");
      return `❌ Could not start the project: ${res.error}`;
    }

    const data = res.data as {
      repo?: string;
      url?: string;
      private?: boolean;
      next_steps?: string;
      skipped?: boolean;
      note?: string;
    };

    if (data.skipped) return `ℹ️ ${data.note ?? `${name} already exists.`}`;

    const audit = await writeAuditEntry({
      action: "create_project_repo",
      idempotency_key: key,
      payload: { repo: data.repo, private: data.private },
      tenant_id: TENANT,
    });
    if (!audit.written) log.warn({ key }, "writeAuditEntry conflict on create_project_repo");

    return (
      `✅ Created ${data.repo} (${data.private ? "private" : "public"})\n` +
      `${data.url}\n\n` +
      `Dispatch will now accept it — /task repo:${(data.repo ?? "").split("/")[1] ?? name} <what to build>\n\n` +
      `${data.next_steps ?? ""}`
    );
  },
  {
    name: "create_project_repo",
    description:
      "Start a NEW project: create a GitHub repository under the founder's account and register it " +
      "as a repository the Antigravity agent loop may be dispatched to. Use when the founder wants to " +
      "begin a project that does not exist yet. Requires founder approval. Do NOT use to open an issue " +
      "or dispatch work on an existing repo — that is dispatch_antigravity_task.",
    schema: z.object({
      name: z
        .string()
        .describe(
          "Repository name only — no owner, no slashes (e.g. 'turicks-pricing-api'). " +
            "Letters, digits, hyphens, underscores and dots.",
        ),
      description: z.string().optional().nullable().describe("One line on what the project is for."),
      isPrivate: z
        .boolean()
        .optional()
        .nullable()
        .describe("Defaults to true. Pass false ONLY if the founder explicitly asked for a public repo."),
    }),
  },
);
