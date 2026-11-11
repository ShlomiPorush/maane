import { defineConfig } from "vitest/config"

// Unit tests run anywhere. Integration tests (*.integration.test.ts) need MAANE_TEST_DATABASE_URL, a disposable
// PostgreSQL that scripts/verify.sh starts with a password generated for the run.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "unit", include: ["src/**/*.test.ts"], exclude: ["src/**/*.integration.test.ts"] } },
      {
        test: {
          name: "integration",
          include: ["src/**/*.integration.test.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
        },
      },
    ],
  },
})
