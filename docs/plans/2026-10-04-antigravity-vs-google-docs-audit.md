# Antigravity setup vs Google's documentation — 2026-10-04

**Status:** findings and recommendations. Sources: antigravity.google/docs (rules, skills, settings, models, mcp), `agy --help` and
`agy models` on the VPS (agy 1.2.16). Only the laptop config was changed (see the agent-setup audit); nothing below
was applied to the VPS or the dispatcher.

## Matches Google's guidance
- **Rules:** global `~/.gemini/GEMINI.md` is a symlink to the shared 6.8 KB rulebook; repo `AGENTS.md` (10 KB) and `GEMINI.md`
  (3 KB). Limits are 24 KB per file and a 20K-token budget for always-on rules, so all are well inside them.
- **VPS skills:** one global skill (`production-ready`), which suits progressive disclosure (the agent sees names and
  descriptions, and loads a skill only when relevant).
- **MCP:** `~/.gemini/config/mcp_config.json` is the documented global path; Playwright removed, brain hub kept.
- **Sandbox:** `enableTerminalSandbox` is the documented key; now on for the laptop.

## Gaps
1. **Dispatched tasks run on the CLI default model.** `agent-dispatch` calls `agy --new-project --print … --dangerously-skip-permissions`
   with no `--model` or `--effort`. `cli.log` shows the default resolving to Gemini 3.8 Flash (High). Available:
   Gemini 3.1 Pro (high/low), Claude Opus/Sonnet 5.5 (low/medium/high), 3.8/3.7/3.6 Flash. `--effort low|medium|high|xhigh|max`
   exists. Quality for coding tasks is a model-and-effort choice nobody has pinned. Recommend an A/B on 3 recent issues
   before changing anything (NOT VERIFIED: no run compared models).
2. **Laptop global skills sit in a legacy folder.** `~/.gemini/antigravity/global_skills/` holds 15 skills; Google's documented
   global path is `~/.gemini/config/skills/`, which holds 3. It is unverified whether the app still reads the legacy folder.
   If it does not, skills such as `doer-contract` and `request-claude-review` never load on the laptop. Check in the app's skills
   panel, then move or symlink.
3. **Policy fields use legacy names.** `config.json` has `autoExecutionPolicy` and `nonWorkspaceFileAccessPolicy`. The docs name
   `toolPermission` (`request-review`, `proceed-in-sandbox`, `strict`, `always-proceed`) and `allowNonWorkspaceAccess`.
   `proceed-in-sandbox` fits this workflow best: commands run without prompts, inside the sandbox. Set it in the UI; the
   docs do not say which file holds it.
4. **Repo skills are mostly off-topic.** `.agents/skills/` is tracked and holds six skills, five of them Apify, whose descriptions load
   every session. Remove them if no FounderOS flow uses Apify.
5. **Standards are advisory, not triggered.** `GEMINI.md` says "read STANDARDS.md in full". Google's `.agents/rules/*.md` supports
   `trigger: glob` (activates when the agent touches matching files), so a rule on `src/**` pointing at STANDARDS would load
   it deterministically. Frontmatter is mandatory there or the file is silently dropped.
6. **VPS headless runs skip permissions** (`--dangerously-skip-permissions`). Recommend adding `--sandbox` to the dispatch call
   if the sandbox does not block git push or `gh`; test on one issue first.
