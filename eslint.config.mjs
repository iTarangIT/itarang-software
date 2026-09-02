import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // ops-agent/ is not app source. It is a dependency-free CommonJS script
    // copied onto the VPS boxes and run by pm2 — no bundler, no transpile, no
    // node_modules. The TypeScript ruleset's no-require-imports does not apply
    // to a file whose whole point is to run as plain CJS on a bare box.
    "ops-agent/**",
  ]),
]);

export default eslintConfig;
