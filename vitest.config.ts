import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The CLI bootstrap runs in a separate child process in integration tests;
      // keep process wiring out of the in-process business-logic coverage.
      exclude: ["src/index.ts"],
      reporter: ["text", "lcov"],
    },
  },
});
