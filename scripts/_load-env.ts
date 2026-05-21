/**
 * Loads .env.local / .env into process.env.
 *
 * Import this FIRST — before any module that reads env at import time (e.g.
 * "@/lib/db", which throws if DATABASE_URL is unset). ESM evaluates imports
 * depth-first in source order, so a leading `import "./_load-env";` runs
 * dotenv.config() before later imports are evaluated. Inline
 * `dotenv.config()` in the script body runs too late under ESM (all imports
 * are hoisted above statements).
 */
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });
