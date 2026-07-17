import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    globalSetup: [],
    setupFiles: ["./tests/setup.ts"],
    // Default run = deterministic, offline-safe layers only. Integration (live
    // Gemini) and smoke (live Telegram) are opt-in via their own scripts.
    include: [
      "tests/unit/**/*.{test,spec}.ts",
      "tests/regression/**/*.{test,spec}.ts",
      // Load suite is stub-invoker only ($0, offline) — safe in the default run.
      // It was silently orphaned before: no include, no script, never in CI.
      "tests/load/**/*.{test,spec}.ts",
    ],
    // Determinism is enforced by the network kill-switch in tests/setup.ts
    // (re-installed before EACH file via setupFiles), NOT by Vitest's global
    // mock-reset knobs. We deliberately leave unstubGlobals/restoreMocks OFF:
    // both auto-restore after every test and nuke module-scope mocks set once at
    // import time (vi.stubGlobal("fetch") in rag/web-search; the Octokit factory
    // in github.test). See docs/TESTING_AUDIT.md for the flaky-suite RCA.
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/**/*.d.ts"],
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    // Resolve .ts files directly (tsx handles this in dev, vitest handles in tests)
    extensions: [".ts", ".js"],
  },
});
