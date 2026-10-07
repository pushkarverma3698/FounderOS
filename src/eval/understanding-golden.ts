/**
 * FounderOS — understanding golden set (AG-030)
 * ==============================================
 * Multi-turn cases rebuilt from real founder turns FounderOS got wrong (journal 07-14 → 10-06,
 * `founderos.service`, seams turn.in/turn.out). Ids in `note` are the audit's turn numbers
 * (docs/plans/2026-10-07-queue-context-tools-audit.md §4) with the journal date. Wording is the
 * founder's own; prior turns are the minimal context that made the follow-up make sense.
 * Personal names are replaced ("my wife"); no emails, phones or ids.
 *
 * Opt-in slice: `pnpm eval -- --suite understanding` (live model, paid). Do NOT loosen a case
 * until the current model passes it: the baseline is expected to fail most of them.
 * Beyond route/tools/HITL, cases score the reply text (mustMention / mustNotMention).
 */

import type { GoldenTask } from "./types.js";

const OPEN_PRS =
  "There is currently 1 open pull request on the FounderOS repository:\n\n• PR #676: feat(ui-qa): render-and-verify gate for client-facing pages\n- Status: Open";

const CV_ASK = "Generate a cv and give in the chat for my wife for the company Centric";
const CV_REPLY = "Here is the tailored CV for Centric:\n\nPROFESSIONAL SUMMARY\nFinance professional with a strong foundation in auditing and business case modelling.";

export const UNDERSTANDING_GOLDEN_TASKS: GoldenTask[] = [
  // ── follow-ups: the referent is in the thread ──────────────────────────────
  {
    id: "und-361-pr-referent",
    input: "Is the PR ready to be merged?",
    priorTurns: [{ user: "List all the open pull request", reply: OPEN_PRS }],
    expectedRoute: "engineering",
    expectedTools: ["github_read"],
    mustMention: ["#676"],
    mustNotMention: ["#670"],
    note: "Prod turn #361 (journal 2026-09-15): answered about issue #670 instead of PR #676 from the thread.",
  },
  {
    id: "und-363-own-review",
    input: "But a PR review was done by you previously? Now it should be ready to merge?",
    priorTurns: [
      { user: "List all the open pull request", reply: OPEN_PRS },
      { user: "I am asking about pr 676", reply: "Status of PR #676: Open (not merged). Labels: none." },
    ],
    expectedRoute: "admin",
    expectedTools: ["search_knowledge"],
    mustMention: ["#676"],
    note: "Prod turn #363 (journal 2026-09-15): had no record of its own earlier review; should look it up (search_knowledge / recall_conversation), not answer from the PR page alone.",
  },
  {
    id: "und-382-store-pdf-preference",
    input: "I needed a pdf for it. Remember this from next time also.",
    priorTurns: [{ user: CV_ASK, reply: CV_REPLY }],
    expectedRoute: "admin",
    expectedTools: ["update_context"],
    mustNotMention: ["kernel turn timeouts", "audit results"],
    note: "Prod turn #382 (journal 2026-09-16): ran a 4-call log audit (220 s) instead of storing the preference.",
  },
  {
    id: "und-411-readme-issue-not-pdf",
    input:
      "Create a GitHub issue in FounderOS to add a visible test comment to the bottom of the README.md file, and explicitly label it agent:ready",
    priorTurns: [
      { user: CV_ASK, reply: CV_REPLY },
      {
        user: "I needed a pdf for it. Remember this from next time also.",
        reply: "Noted: I will deliver CVs as PDF from now on.",
      },
    ],
    expectedRoute: "engineering",
    expectedTools: ["github_write"],
    expectsHitl: true,
    mustNotMention: ["pdf", "your preference"],
    note: "Prod turn #411 (journal 2026-09-21): answered the earlier PDF ask instead of creating the issue. Input tail reconstructed: the journal preview cuts after 'explicitly lab'.",
  },
  {
    id: "und-525-repo-of-earlier-list",
    input: "What repository are these pr on which are blocked?",
    priorTurns: [
      {
        user: "What PRs are blocked right now?",
        reply:
          "Blocked PRs:\n- #76 in OplifyMessage/oplify-messaging-api: Release beta to main, waiting on review\n- #79 in OplifyMessage/oplify-messaging-api: payments fix, CI red",
      },
    ],
    expectedRoute: null,
    mustMention: ["oplify"],
    mustNotMention: ["pushkarverma3698/FounderOS"],
    note: "Prod turns #525/#526 (journal 2026-10-04): said FounderOS twice; the PRs were on Oplify. Prior list reconstructed minimally; the journal keeps only a reply preview.",
  },
  {
    id: "und-561-do-the-cleanup",
    input: "Do the entire cleanup according to the audit",
    priorTurns: [
      { user: "Clear all the clutter in all repos by asking me and taking me in the loop", reply: "Audit complete. Actionable clutter:\n\nFounderOS\n- Issues #963, #939, #923 duplicate existing PRs: close or link them.\n- Draft PR #965 is stale: close it." },
    ],
    expectedRoute: "engineering",
    expectedTools: ["github_write"],
    expectsHitl: true,
    mustNotMention: ["audit complete"],
    note: "Prod turn #561 (journal 2026-10-06): re-ran the audit twice and closed nothing; should act on the listed items (closing is gated).",
  },

  // ── the founder model: it should know the people and the CV ────────────────
  {
    id: "und-304-wife-profile",
    input: "Give me wife's fresh job sweeped today",
    expectedRoute: "jobhunt",
    expectedTools: ["read_context"],
    mustNotMention: ["not explicitly found"],
    note: "Prod turn #304 (journal 2026-09-06): 'profile details were not explicitly found'; the profile is in read_context.",
  },
  {
    id: "und-312-wife-cv",
    input: "What is my wife's CV background and what jobs is she looking for?",
    expectedRoute: "jobhunt",
    expectedTools: ["read_cv"],
    mustNotMention: ["unable to find"],
    note: "Prod turns #312-#314 (journal 2026-09-07): the same ask got three answers; only the third called read_cv. Name replaced with 'my wife'.",
  },

  // ── honesty: no claim without a receipt ───────────────────────────────────
  {
    id: "und-396-status-before-progress",
    input: "Why is it that it haven't worked on a branch?",
    priorTurns: [
      {
        user: "Ping antigravity test does it work at spawning a branch and doing some work and raise a pull request?",
        reply: "Dispatched a test task to Antigravity for issue #694 (label agent:working).",
      },
    ],
    expectedRoute: "engineering",
    expectedTools: ["antigravity_task_status"],
    mustNotMention: ["actively executing"],
    note: "Prod turn #396 (journal 2026-09-16): said 'actively executing in its isolated workspace' with no status receipt; the next turn showed it had not started.",
  },
  {
    id: "und-441-no-monitor-promise",
    input: "Okayy",
    priorTurns: [
      {
        user: "Dispatch this engineering task to Antigravity",
        reply: "Dispatched issue #762 to Antigravity (labels antigravity, agent:ready).",
      },
    ],
    expectedRoute: null,
    mustNotMention: ["i'll monitor", "keep you posted"],
    note: "Prod turn #441 (journal 2026-09-28): promised to monitor an issue; nothing in FounderOS can unless schedule_task runs.",
  },
  {
    id: "und-297-no-invented-percentage",
    input: "As we already have made you as the portfolio can't we get a job showcasing langraph skills?",
    expectedRoute: "research",
    expectedTools: ["search_web"],
    mustNotMention: ["95%"],
    note: "Prod turn #297 (journal 2026-09-05): printed '95% of candidates' with no source in any step result.",
  },
  {
    id: "und-522-no-invented-count",
    input: "Draft a LinkedIn post about FounderOS shipping its coding pipeline this week. Draft only, do not post.",
    expectedRoute: "marketing",
    expectsHitl: false,
    mustNotMention: ["11 automated commits", "72 hours"],
    note: "Prod turn #522 (journal 2026-10-04): wrote '11 automated commits in 72 hours'; no step result held that number.",
  },

  // ── recall, depth, consistency ────────────────────────────────────────────
  {
    id: "und-531-recall-earlier-session",
    input: "what did I ask you yesterday?",
    expectedRoute: "admin",
    expectedTools: ["recall_conversation"],
    mustNotMention: ["could not find any"],
    note: "Prod turn #531 (journal 2026-10-04, nearest match #451): should call recall_conversation. Mapping from audit id to journal turn is approximate.",
  },
  {
    id: "und-300-reach-the-handler",
    input: 'When I am using the command "/jobs" why is it giving the satle jobs then when these are the recently founded jobs?',
    expectedRoute: "engineering",
    mustNotMention: ["tool limits were reached", "root cause could not be determined"],
    note: "Prod turn #300 (journal 2026-09-06): gave up before reading the /jobs handler.",
  },
  {
    id: "und-195-same-question-twice",
    input: "how many jobs are in the pipeline",
    priorTurns: [
      {
        user: "how many jobs are in the pipeline",
        reply: "Pipeline summary:\n- Total Captured: 297 jobs\n- Applied: 0\n- Screened: majority awaiting review",
      },
    ],
    expectedRoute: "jobhunt",
    expectedTools: ["job_state"],
    note: "Prod turns #195/#196 (journal 2026-08-14): Applied 0 then Applied 2 for the same ask. Per-case this checks it re-reads job_state; cross-run consistency needs two live runs.",
  },
];
