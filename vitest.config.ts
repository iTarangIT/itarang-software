import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vitest is scoped to pure, no-I/O unit tests (the scoring engine, and the
// Sheet-review text parser that decides what becomes ground truth). The `@`
// alias mirrors tsconfig so suites that import a few app modules resolve.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: [
      "src/**/__tests__/**/*.test.ts",
      "src/**/*.test.ts",
      // Only pure helpers live here — never the scripts themselves, which run
      // main() at import and would open a database connection on collection.
      "scripts/**/__tests__/**/*.test.ts",
    ],
    environment: "node",
  },
});
