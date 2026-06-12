import { defineConfig } from "vitest/config";

/**
 * Integration / live config — opt-in real network (ALLOW_NETWORK=1 is set by the
 * `test:integration` / `test:live` scripts). These suites hit live Gemini and a
 * real Postgres checkpointer, so they run separately from the deterministic
 * default suite and are gated on secrets in CI.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/integration/**/*.{test,spec}.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
});
