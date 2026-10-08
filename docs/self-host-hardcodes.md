# Founder-specific values still in the code

Inventory for AG-043. A developer who self-hosts FounderOS (see [SELF-HOST.md](SELF-HOST.md)) gets a
working Telegram bot, kernel, database and deploy path with only environment variables. The values
below are still the founder's. None of them stops the core bot from booting; each one limits a feature
until it moves to config. This file moves nothing: it says where each value lives and where it should go.

Method: `grep -rnE` over `src/`, `deploy/` and `scripts/seed-founder-context.ts` for the owner's GitHub
login, the org and repo names, the tenant key, the domains, the VPS host name, the founder's home path
and personal names. File:line is correct as of this commit. Comment-only matches are left out.

No Telegram chat id, phone number, e-mail address or token literal exists in `src/` or `deploy/`: a
grep for 9 to 13 digit numbers finds only hex tables, a LinkedIn URN example and comments. Chat ids
come from `TELEGRAM_CHAT_ID` and `TELEGRAM_ALLOWED_CHAT_IDS`.

"Move" is the proposed fix; the cost is S (a constant), M (a config key plus a reader) or L (data in a
table or a design change).

## 1. Repo allowlist and GitHub owner

| # | Where | Value | Effect on a self-host | Proposed move |
|---|-------|-------|-----------------------|---------------|
| 1 | `src/tools/dispatch-repos.ts:23-27` | `DISPATCH_REPO_ALLOWLIST`: 5 repos of the founder and the Oplify org | `/task` refuses every repo that is not on the list | Read the list from `DISPATCH_REPOS` (comma separated); keep the current five only when it is unset. M |
| 2 | `src/tools/dispatch-repos.ts:191-194` | `REPO_ALIASES`: short names (hulda, oplify-app, oplify-api, sandbox) | Aliases point at repos you do not own | Derive from the same config as row 1, or drop. S |
| 3 | `src/gateway/repo-picker.ts:63-66` | Repo buttons built from the same names | Buttons offer repos you cannot reach | Build from the list in row 1. S |
| 4 | `deploy/agent-dispatch:115` | `DEFAULT_REPOS` in the dispatch daemon | Daemon polls the founder's repos; `ISSUE_REPOS` adds yours but the defaults stay | Default to empty and require `ISSUE_REPOS`. S |
| 5 | `src/core/config.ts:142` | `SELF_IMPROVE_ISSUE_REPO` default `pushkarverma3698/FounderOS` | Self-improvement issues are filed in the founder's repo | Env override exists. Make the default empty and fail loud when the feature is on. Not done here: it needs a check of prod's `.env` first. S |
| 6 | `src/agents/agent-tools/engineering.ts:186,207` | Owner login in tool defaults | Engineering tool defaults to the founder's account | Read the owner from `GITHUB_OWNER` or from the token's user. S |
| 7 | `src/agents/agent-tools/antigravity.ts:270`, `antigravity-followup.ts:35`, `src/tools/dispatch-antigravity.ts:261` | Owner login in agent dispatch | Agent PR lookups and follow-ups target the founder's namespace | Same source as row 6. S |
| 8 | `src/agents/agent-tools/project-repo.ts:37` | Owner login when creating a project repo | New repos are created under the founder's login | Same source as row 6. S |
| 9 | `src/agents/prompts/engineering.ts:21,50` | Owner login inside the engineering prompt | The model is told the founder's repos are yours | Template the prompt from config. M |
| 10 | `src/tools/browser/app-recipes.ts:111,163` | Oplify and sandbox repo names in QA recipes | Browser QA recipes only know the founder's apps | Move recipes to a per-install file. M |
| 11 | `src/kernel/planner.ts:153` | Oplify repo names in the planner prompt | Planner routes "oplify" to repos you do not have | Template from row 1. S |
| 12 | `deploy/lib/evidence-card.sh:20`, `deploy/vps-daemons/pr-brain:642,1067` | Oplify org name in PR-gate scripts | PR gate treats that org specially | Read from `ISSUE_REPOS`. S |
| 13 | `deploy/onboard-repo.sh:311` | Owner login in an error-text example | Cosmetic | Use a placeholder. S |

## 2. Tenant and account keys

| # | Where | Value | Effect | Proposed move |
|---|-------|-------|--------|---------------|
| 14 | `src/core/config.ts:37` | `FOUNDER_TENANT` default `turicks` | Env override exists. Rows keyed by tenant use it | Keep; document that changing it after data exists orphans rows. S |
| 15 | `src/core/accounts.ts:11,68-79,143` | `ACCOUNT_KEYS`, role-to-account map, `DEFAULT_ACCOUNT_KEY` | Credentials resolve through the `turicks` account | Load the account table from config. L |
| 16 | `src/infra/credential-resolver.ts:75-102` | `turicks` gets un-suffixed env names (`GITHUB_TOKEN`, `LINKEDIN_*`) | This is why a self-host uses the plain names | Fine for one tenant. Document only. S |
| 17 | `src/core/companies.ts:43-76` | Company profiles keyed `turicks`, knowledge store `turicks-brain` | Company context is the founder's business | Move to a seed file the installer asks for. L |
| 18 | `src/core/linkedin-posting-policy.ts:37,48` | Posting policy for account `turicks` | LinkedIn posting rules assume that account | Per-account config. M |
| 19 | `src/infra/health.ts:76,129,266` | `TRACKED_TENANTS`, tenant literals in health SQL | `/health` counts the founder's tenants | Use `TENANT` from config. S |
| 20 | `src/tools/ops-state.ts:20`, `src/db/queries.ts:22`, `job-queries.ts:41`, `job-run-queries.ts:18`, `job-ref-queries.ts:16`, `apply-queries.ts:24`, `cv-signal-queries.ts:20`, `gap-scan-queries.ts:17` | Tenant default `turicks` in query helpers | Same value as row 14; correct while the env default is unchanged | Take the default from `TENANT`. S |
| 21 | `src/db/schema.ts:64,368,443,568,612,670,802` | Column default `'turicks'` | New rows get that tenant id | Needs a migration. L |
| 22 | `src/infra/answer-eval.ts:33`, `src/evolution/run-audit.ts:37`, `src/kernel/synthesizer.ts:177`, `src/db/brain-ingest.ts:35`, `src/tools/calendar.ts:63`, `src/mcp/server.ts:213` | Tenant literal passed to helpers | Same as row 20 | Use `TENANT`. S |

## 3. People, profiles and brands

| # | Where | Value | Effect | Proposed move |
|---|-------|-------|--------|---------------|
| 23 | `src/tools/jobhunt/profile-config.ts:140-143` | Job-hunt profiles for the founder and a second person | Job hunt searches for the founder's CV and roles | Profiles from a data file under `FOUNDEROS_DATA_ROOT`. L |
| 24 | `src/tools/jobhunt/profiles/wife-nl-finance.ts:46-51` | Second profile and `WIFE_CV_PATH` default | Optional lane; env override exists | Leave off by default. S |
| 25 | `src/core/accounts.ts:155,166`, `src/gateway/wife-commands.ts:28-29`, `src/gateway/home-menu.ts:141,200`, `src/gateway/command-menu.ts:67-382`, `src/gateway/kernel-boot.ts:91` | The spouse's name in menus, command help and an account label | Menus show names that are not yours | Label from config. M |
| 26 | `src/agents/prompts/sales.ts:12,19`, `marketing.ts:2,16`, `comms.ts:21`, `scheduler.ts:2`, `src/agents/agent-tools/state.ts:61` | Founder name and business in worker prompts | The model is told it works for the founder | Template from the founder-context table. M |
| 27 | `src/tools/career.ts:67`, `rag.ts:40`, `job-state.ts:159-160`, `jobhunt/jobs-csv.ts:86,97`, `jobhunt/tailor-tool.ts:37`, `src/mcp/server.ts:148`, `src/eval/command-golden.ts:59` | Names in tool text and eval fixtures | Cosmetic, except the tailor text | Template. S |
| 28 | `scripts/seed-founder-context.ts` | The founder's identity and business context, written to the DB by `deploy.sh` | A friend would get the founder's profile | Done in this change: `deploy.sh` skips it when `FOUNDEROS_SKIP_FOUNDER_SEED=1` (install.sh sets it). |
| 29 | `src/db/retired-seed-values.ts:30-91` | Old founder seed values kept to detect stale rows | Inert on a new install | None needed. |

## 4. Domains, hosts and paths

| # | Where | Value | Effect | Proposed move |
|---|-------|-------|--------|---------------|
| 30 | `src/tools/deploy-static-site.ts:91` | The founder's proof-site domain | Static-site deploy targets that domain | `PROOF_SITE_DOMAIN` env. S |
| 31 | `src/agents/prompts/marketing.ts:31,74` | Same domain inside the prompt | Same | Template. S |
| 32 | `src/tools/create-project-repo.ts:88-91`, `src/gateway/login/adapters/agy.ts:100` | SSH alias `founderos-vps` in operator hints | Hints name an alias you do not have | `FOUNDEROS_SSH_HOST`. S |
| 33 | `deploy/agent-dispatch:395,464,495-500,798`, `deploy/vps-daemons/pr-brain:295,457,467,469,589,1421` | Same alias in daemon messages | Cosmetic | Same. S |
| 34 | `src/tools/calendar.ts:49,61`, `src/agents/agent-tools/comms.ts:444`, `src/agents/prompts/comms.ts:44` | Default timezone `Europe/Amsterdam` | Calendar events default to that zone unless the model passes one | `APP_TIMEZONE` already exists for rendering; use it here. S |
| 35 | `src/core/config.ts:398` | `ARTIFACT_ROOT` fallback under the founder's Mac home | Linux boxes override or fail | Default under `FOUNDEROS_DATA_ROOT`. S |
| 36 | `src/tools/claude-code.ts:49`, `opencode.ts:46,107`, `career.ts:32`, `claude-code-cwd.ts:21`, `project-workflow.ts:45,113` | Fallback paths under the founder's Mac home | Dev-machine only; prod sets env | Fail loud when unset. S |
| 37 | `src/core/data-root.ts:13` | `DEFAULT_DATA_ROOT=/opt/founderos-data` | Env override exists (`FOUNDEROS_DATA_ROOT`); install.sh sets it | None. |
| 38 | `src/tools/jobhunt/free-boards-discovered.ts:30` | `/opt/founderos-data/free-ats-discovered.csv` as a literal | Ignores `FOUNDEROS_DATA_ROOT` | Build the path from the data root. S |
| 39 | `src/infra/google-mailboxes.ts:23`, `src/tools/claude-code-git-guard.ts:183`, `src/core/accounts.ts:126`, `src/gateway/login/adapters/google.ts:40` | `HOME` fallback `/home/founderos` | Wrong only when `HOME` is unset; systemd sets it | None. |
| 40 | `deploy/systemd/agy-login.*`, `fos-job*`, `deploy/lib/evidence-card.sh:17`, `deploy/lib/executor-prompt.sh:25`, `deploy/job-run`, `deploy/vps-daemons/pr-brain:921`, `scripts/apply-prod-env-overrides.sh` | `/opt/founderos`, `/home/founderos`, users `founderos` and `antigravity` | `install.sh` renders `founderos.service` for your paths. The agy-login and fos-job units keep the founder's paths and users | Render the remaining units the way `founderos.service` is rendered. M |
| 41 | `src/tools/dispatch-antigravity.ts:87` | `/opt/founderos` in the agent brief text | Cosmetic | Template. S |

Total: 41 inventory rows (some cover several lines).

## Order I would move them in

1. Rows 1-4 and 12: repo list from one env var. Unblocks `/task` and the dispatch daemon for a friend.
2. Rows 6-9: GitHub owner from one source.
3. Rows 19-20, 22, 34-35, 38: small constants that already have an env twin.
4. Rows 15, 17, 21, 23, 25-26: accounts, company and people data into a table. This is the real multi-user work and is out of scope for a single-tenant self-host.
