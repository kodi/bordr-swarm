import { ComposeReporter } from "vitecompose/node";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    globalSetup: ["./compose.setup.ts"],
    reporters: [new ComposeReporter()],
    fileParallelism: false,
    sequence: { concurrent: false },
    retry: 0,
    testTimeout: 120_000,
    teardownTimeout: 60_000,
  },
});
