/**
 * FounderOS — app recipes: how to boot a dispatchable repo and what to look at
 * ============================================================================
 * PURE. No I/O, no clock, no browser. A recipe is the answer to three questions
 * a reviewer cannot get from a diff:
 *
 *   1. How do I start this app from a fresh checkout?
 *   2. Which URLs does an unauthenticated visitor actually reach?
 *   3. Which changed files make looking at it worth the minutes it costs?
 *
 * ## Why the recipe lives HERE and not in the app's own repository
 *
 * Two of the four dispatchable repos belong to an employer. Adding a Playwright
 * config, a `test:e2e` script and a devDependency to someone else's repository is
 * a change they have to agree to, review and maintain — and it would arrive in
 * every agent PR's diff as noise. Keeping the recipe on this side means the gate
 * is ours, the employer's repo is untouched, and a repo that changes its start
 * command costs one line here instead of a negotiation.
 *
 * It also removes the dependency on a per-PR preview deployment. Vercel refuses
 * to build agent-authored PRs on oplify-messaging-app until its commit-author
 * check is changed, which is the founder's (or his employer's) call and not
 * something this loop may wait on. Booting the checkout ourselves needs nobody's
 * permission and works identically on a repo that has no hosting at all.
 *
 * ## What a recipe deliberately does NOT promise
 *
 * `routes` lists the PUBLIC surface. Every dispatchable app so far puts its real
 * screens behind a login, and a gate that navigates to /dashboard with no session
 * measures the login page twice and reports it as two clean rows — a pass that
 * checked nothing. `authNote` is printed verbatim in the evidence pack so the
 * reader is told which screens were NOT looked at, every single run. A gate that
 * silently covers 2 of 30 routes is worse than no gate.
 */

import type { UiDefect, UiDefectKind } from "./ui-analyze.js";

/** One HTTP path to render, with the label it gets in the report. */
export interface RecipeRoute {
  readonly id: string;
  readonly path: string;
}

export interface AppRecipe {
  /** `owner/name`, matched case-insensitively against the dispatch allowlist. */
  readonly repo: string;
  /** Human name for the report header. */
  readonly label: string;
  /** Dependency install, run once in the checkout. */
  readonly install: readonly string[];
  /** Optional production build. Omitted for apps served straight from source. */
  readonly build?: readonly string[];
  /**
   * The serve command. `{PORT}` in any argument is replaced with the chosen port
   * — every framework spells the flag differently and none of them read a plain
   * PORT env var reliably.
   */
  readonly start: readonly string[];
  /** Default port. Overridable so two gates can run on one box. */
  readonly port: number;
  /** Polled until it answers before any measuring starts. */
  readonly readyPath: string;
  /** The public surface. See the header: this is not the whole app. */
  readonly routes: readonly RecipeRoute[];
  /**
   * Printed verbatim in the pack. Says which part of the product this gate does
   * NOT see, so a clean report is never read as "the app works".
   */
  readonly authNote: string;
  /**
   * Path prefixes whose change makes the gate worth running. A PR touching only
   * README.md gets SKIPPED with that reason rather than a five-minute build.
   */
  readonly triggerPaths: readonly string[];
  /** Env for both build and start. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * The dependencies this gate knowingly does not have — the app's own backend,
   * and any third party that needs a real credential. Each entry is a substring
   * matched against a defect's printed detail, plus the reason a reader is given
   * for why that row is not this pull request's fault.
   *
   * Substring-on-the-detail rather than a URL host, because the most useful of
   * these are not requests at all: Google Identity logs `[GSI_LOGGER]: The given
   * client ID is not found.` from a gstatic script, so the host that would match
   * is not the host the row is about.
   */
  readonly expectedExternal?: readonly { match: string; reason: string }[];
}

/**
 * The unreachable address every recipe points its API client at.
 *
 * Deliberately a port nothing listens on rather than an unset variable: an unset
 * base URL makes the client issue same-origin requests, which the preview server
 * answers with index.html and a JSON parse error deep inside the app — a
 * confusing defect that belongs to the gate, not to the PR. A refused connection
 * to a fixed, recognisable address is unambiguous and attributable in one line.
 *
 * NOT a low "obviously dead" port. Chromium refuses to dial its own restricted
 * list (9/discard, 19/chargen, 25/smtp and ~60 others) with `net::ERR_UNSAFE_PORT`
 * BEFORE any connection is attempted — measured on the first live run against
 * oplify-messaging-app, where it produced a console error the browser attributes
 * to no URL at all and which therefore could not be labelled as ours. A high
 * unprivileged port gives an honest ERR_CONNECTION_REFUSED that carries its URL.
 */
export const OFFLINE_API_ORIGIN = "http://127.0.0.1:59999";

export const APP_RECIPES: readonly AppRecipe[] = [
  {
    repo: "OplifyMessage/oplify-messaging-app",
    label: "Oplify Messaging (React + Vite SPA)",
    install: ["npm", "ci"],
    build: ["npm", "run", "build"],
    // `preview` serves the production build with SPA fallback, which is what a
    // visitor gets. `dev` would measure the dev server's own error overlay and
    // hot-reload client instead of the artifact that ships.
    start: ["npm", "run", "preview", "--", "--port", "{PORT}", "--host", "127.0.0.1"],
    port: 4173,
    readyPath: "/",
    routes: [
      { id: "login", path: "/" },
      { id: "forgot-password", path: "/forgot-password" },
    ],
    authNote:
      "Only the signed-out surface (login, forgot-password) was rendered. The authenticated " +
      "screens — dashboard, contacts, campaigns, templates, analytics and the rest — were NOT " +
      "checked: this gate holds no test credentials. A change to any of them is unverified here.",
    triggerPaths: ["src/", "public/", "index.html", "vite.config.js", "package.json"],
    // EVERY key in the repo's .env.example gets a value, not just the two this
    // gate cares about. A key left unset is `undefined` at the call site, and the
    // first live run showed the app building a third-party script URL ending in
    // the literal string "undefined" — a defect the gate manufactured and would
    // then have reported against the pull request that did not cause it.
    env: {
      VITE_API_BASE_URL: `${OFFLINE_API_ORIGIN}/api/v1`,
      VITE_SOCKET_API_BASE_URL: OFFLINE_API_ORIGIN,
      VITE_META_APP_ID: "qa-gate-placeholder",
      VITE_META_CONFIG_ID: "qa-gate-placeholder",
      VITE_RAZORPAY_KEY_ID: "qa-gate-placeholder",
      VITE_GOOGLE_CLIENT_ID: "qa-gate-placeholder.apps.googleusercontent.com",
    },
    expectedExternal: [
      {
        match: OFFLINE_API_ORIGIN.replace("http://", ""),
        reason:
          "this gate points the API client at a port nothing listens on, so every backend call " +
          "fails by design. Any screen that needs live data is therefore unverified here",
      },
      {
        match: "accounts.google.com",
        reason:
          "Google Identity is initialised with a placeholder client id, which Google answers 403. " +
          "Sign-in with Google is unverified here",
      },
      {
        match: "[GSI_LOGGER]",
        reason: "the same placeholder Google client id, logged by Google's own script",
      },
    ],
  },
  {
    repo: "pushkarverma3698/House-of-Hulda-Website-frontend",
    label: "House of Hulda (Next.js)",
    install: ["npm", "ci"],
    build: ["npm", "run", "build"],
    start: ["npm", "run", "start", "--", "-p", "{PORT}"],
    port: 3100,
    readyPath: "/",
    routes: [{ id: "home", path: "/" }],
    authNote: "The whole site is public, so this gate covers it end to end.",
    triggerPaths: ["app/", "src/", "components/", "public/", "next.config", "package.json"],
  },
];

/** The recipe for `owner/name`, or null when this repo has no boot instructions. */
export function recipeForRepo(slug: string): AppRecipe | null {
  const lowered = slug.trim().toLowerCase();
  return APP_RECIPES.find((r) => r.repo.toLowerCase() === lowered) ?? null;
}

/**
 * True when at least one changed file sits under a trigger path.
 *
 * An EMPTY change list returns true, not false. "I could not read the diff" and
 * "the diff is irrelevant" are different answers, and collapsing them into a
 * skip is the did-not-run-reads-as-clean failure this repo keeps paying for.
 * Unknown means run it.
 */
export function recipeIsTriggered(recipe: AppRecipe, changedFiles: readonly string[]): boolean {
  if (changedFiles.length === 0) return true;
  return changedFiles.some((file) => recipe.triggerPaths.some((prefix) => file.startsWith(prefix)));
}

/** Substitutes `{PORT}` and returns the argv to spawn. */
export function resolveCommand(command: readonly string[], port: number): string[] {
  return command.map((arg) => arg.replace("{PORT}", String(port)));
}

/** Every URL this recipe should render, in report order. */
export function recipeTargets(recipe: AppRecipe, origin: string): Array<{ id: string; url: string }> {
  return recipe.routes.map((route) => ({ id: route.id, url: `${origin}${route.path}` }));
}

/**
 * Re-label the defects caused by the dependencies this gate deliberately did not
 * provide — the app's own backend, and third parties needing a real credential.
 *
 * PURE. Without this every pull request on a front-end repo carries the same
 * handful of rows: an API refusing a connection that was aimed at a dead port on
 * purpose, and Google answering 403 to a placeholder client id. A gate that is
 * noisy on every PR is a gate everybody learns to scroll past — that is the
 * failure mode this guards against, not a tuning knob. Both were measured on the
 * first two live runs against oplify-messaging-app.
 *
 * Two rules keep the downgrade honest:
 *
 * · It only touches `failed-asset` and `console-error`. An UNCAUGHT exception
 *   (`page-error`) stays HIGH even when it names an expected-missing dependency,
 *   because an app that throws instead of handling a failed request is broken for
 *   any visitor whose network hiccups — a real finding, and the most valuable one
 *   this node can catch.
 * · Nothing is dropped. The row still prints, at `low`, carrying the recipe's own
 *   sentence about what that means was left unverified. A defect deleted from a
 *   report is a defect nobody can disagree with.
 */
export function annotateExpectedExternal(
  defects: readonly UiDefect[],
  expected: readonly { match: string; reason: string }[] = [],
): UiDefect[] {
  if (expected.length === 0) return [...defects];

  const DOWNGRADABLE: ReadonlySet<UiDefectKind> = new Set(["failed-asset", "console-error"]);

  return defects.map((defect) => {
    if (!DOWNGRADABLE.has(defect.kind)) return defect;
    const hit = expected.find((e) => defect.detail.includes(e.match));
    if (!hit) return defect;
    return {
      ...defect,
      severity: "low" as const,
      detail:
        `[expected — not provided by this gate] ${defect.detail} ` +
        `Reason: ${hit.reason}. This is NOT evidence of a defect in this pull request.`,
    };
  });
}
