import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Vitest is scoped to pure, no-I/O unit tests (the scoring engine). The `@`
// alias mirrors tsconfig so suites that import a few app modules resolve.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
  },
});
