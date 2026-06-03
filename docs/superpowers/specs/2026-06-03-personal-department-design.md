# Personal Department — Design Spec

> Date: 2026-06-03 · Branch: `feat/personal-department` · Status: approved, in build

## Goal
Add a 7th FounderOS department, `personal` — a senior-engineer agent that operates the
founder's own laptop (read/edit files, run scripts, drive the browser) over Telegram,
with every dangerous action gated behind HITL approval.

## Decisions (locked with founder)
1. **Access scope = home directory.** File/shell tools operate under `$HOME`
   (`PERSONAL_ROOT` env override). System paths and secret paths are denied **even for reads**.
2. **Browser = AppleScript MVP.** A `browser` tool drives Safari via `osascript`
   (`open_url`, `get_page_text`, `run_js`). Full Safari-MCP client integration is **deferred to Phase 2**.
3. **HITL on every write, shell, and browser action.** Reads (`read_file`, `list_dir`) are instant;
   everything else shows an Approve/Reject card before the side-effect runs.

## Threat model (why the guard exists)
The agent already ingests untrusted text (emails, web pages) → prompt-injection is in scope.
Mitigations, in order:
- **`interrupt()` HITL gate** on all writes/shell/browser — the founder sees the exact path/command
  before anything runs. Load-bearing control.
- **`path-guard`** — every file path and shell `cwd` must resolve inside `$HOME`; a denylist blocks
  secret + system paths even on read (exfil targets).
- **Danger heuristic** — `run_shell` flags catastrophic patterns (`rm -rf /`, `mkfs`, `dd of=/dev/…`,
  fork bombs) prominently in the approval card. Approval remains the final control.

## Components
| Unit | Purpose | Tested |
|---|---|---|
| `src/infra/path-guard.ts` | Pure: `resolveSafePath(input) → {ok,path}\|{ok:false,reason}`; `flagDangerousCommand(cmd)`. | unit |
| `src/tools/personal.ts` | Raw impl: `readFileSafe`, `listDirSafe`, `writeFileSafe`, `runShellSafe`, `browserAction`. Guard-enforced. | unit |
| `src/agents/agent-tools.ts` | 5 LangChain `tool()` wrappers; write/shell/browser `interrupt()` before side-effect. | via office/eval |
| `src/agents/office.ts` | `personal` ReAct agent registered in `createSupervisor`. | — |
| `src/agents/system-prompts.ts` | `PERSONAL_PROMPT` (senior-engineer persona) + supervisor routing line. | — |
| `src/eval/golden-tasks.ts` | `personal-read-file`, `personal-run-script`, `personal-browser`. | eval |

## path-guard contract
- Expand `~`, resolve absolute, reject if outside `PERSONAL_ROOT ?? os.homedir()`.
- Reject traversal that escapes root (`../../etc/passwd`).
- Denylist (substring/segment match, blocks read+write): `.ssh`, `.aws`, `.gnupg`,
  `.config/gh`, `Library/Keychains`, `*.pem`, `id_rsa*`, `.env`; absolute system roots
  `/etc`, `/System`, `/Library`, `/private`, `/usr`, `/bin`.

## Tool gates
| Tool | Gate | Approval preview |
|---|---|---|
| `read_file` | none | — |
| `list_dir` | none | — |
| `write_file` | HITL | path + content |
| `run_shell` | HITL | command + cwd (+ danger flag) |
| `browser` | HITL | action + url/js |

## Success criteria
- `pnpm test` green (new path-guard + personal unit tests included); `tsc` clean.
- Live: reading a home file works ungated; running a script and a browser action each fire a HITL card;
  a read of `~/.ssh/id_rsa` (or `.env`) is refused by the guard.
- `pnpm eval` still passes with the 3 added personal golden tasks.

## Out of scope (Phase 2)
- Full Safari-MCP client subprocess + its 80+ tools.
- Sandboxed-workspace-only mode (guard already supports it via `PERSONAL_ROOT`).
- Per-command allowlists / OS-level sandboxing (seatbelt).
