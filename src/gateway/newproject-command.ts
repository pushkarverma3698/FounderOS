import type { Context } from "grammy";
import { validateProjectRepoName } from "../tools/create-project-repo.js";

const NEW_PROJECT_USAGE = [
  "Usage: /newproject <name> <what it is>",
  "",
  "Example:",
  "  /newproject turicks-pricing-api usage-based pricing service for Turicks",
  "",
  "Creates a PRIVATE repo under your account and lets the agent loop work in it.",
  "You approve the name before anything is created.",
].join("\n");

export interface NewProjectArgs {
  readonly name: string;
  readonly description: string;
}

export type NewProjectParse =
  | { readonly ok: true; readonly args: NewProjectArgs }
  | { readonly ok: false; readonly message: string };

/** Splits `<name> <description…>` and rejects a name GitHub would rewrite. */
export function parseNewProjectArgs(raw: string): NewProjectParse {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: NEW_PROJECT_USAGE };

  const [name, ...rest] = trimmed.split(/\s+/);
  const invalid = validateProjectRepoName(name ?? "");
  if (invalid) return { ok: false, message: `${invalid}\n\n${NEW_PROJECT_USAGE}` };

  return { ok: true, args: { name: name as string, description: rest.join(" ").trim() } };
}

/**
 * Routed through the kernel for the same reason as /task: the approval card belongs to
 * the tool, and a gateway-local card would resume an unrelated paused checkpoint.
 */
export function buildNewProjectInstruction(args: NewProjectArgs): string {
  return [
    `Start a new project by calling the create_project_repo tool.`,
    ``,
    `Repository name: ${args.name}`,
    `Description: ${args.description || "(none given)"}`,
    `Visibility: private — do not pass isPrivate unless the founder asked for a public repo.`,
    ``,
    `Call the tool once with exactly that name. Do not create files, do not scaffold`,
    `anything, and do not dispatch any work yet — creating the repository is the whole task.`,
  ].join("\n");
}

export interface NewProjectCommandDeps {
  readonly runKernelText: (ctx: Context, text: string) => Promise<void>;
}

export async function handleNewProject(ctx: Context, deps: NewProjectCommandDeps): Promise<void> {
  const parsed = parseNewProjectArgs(ctx.match?.toString() ?? "");
  if (!parsed.ok) {
    await ctx.reply(parsed.message);
    return;
  }

  await deps.runKernelText(ctx, buildNewProjectInstruction(parsed.args));
}
