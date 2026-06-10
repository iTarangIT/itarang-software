#!/usr/bin/env node
// One-shot: apply the E-164 draft_step migration to $DATABASE_URL (AWS RDS).
// No-argument wrapper so it runs on a single line (avoids the path line-wrap
// that split the command before):
//   node scripts/apply-e164.mjs
// Additive + idempotent (ADD COLUMN IF NOT EXISTS) — safe to re-run.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const FILE = "drizzle/E-164_dealer_onboarding_draft_step.sql";

async function loadDotEnvLocal() {
  try {
    const raw = await readFile(resolve(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (!m) continue;
      const [, k, vRaw] = m;
      if (process.env[k]) continue;
      process.env[k] = vRaw.replace(/^["'](.*)["']$/, "$1");
    }
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

async function main() {
  await loadDotEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (neither in env nor .env.local)");
    process.exit(1);
  }
  const sql = await readFile(resolve(process.cwd(), FILE), "utf8");
  console.log(`> applying ${FILE}`);
  console.log(`> target host: ${new URL(url).host}`);

  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("COMMIT");
    const r = await client.query(
      "select column_name, data_type, column_default from information_schema.columns where table_name='dealer_onboarding_applications' and column_name='draft_step'"
    );
    console.log("> ok — migration applied. draft_step =>", JSON.stringify(r.rows));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("> failed:", err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
