import { defineConfig } from "drizzle-kit";
import * as dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');

export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  },
  // When TABLE_PREFIX is set (orkivanta sandbox lane: TABLE_PREFIX=sandbox_),
  // scope drizzle-kit to ONLY the prefixed tables so `db:push` is physically
  // unable to propose drops/alters on the unprefixed production tables that
  // share the same database.
  tablesFilter: process.env.TABLE_PREFIX
    ? [`${process.env.TABLE_PREFIX}*`]
    : ["!pg_stat_*"],
});