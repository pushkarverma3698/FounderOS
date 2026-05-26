import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    globalSetup: [],
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.{test,spec}.ts"],
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
