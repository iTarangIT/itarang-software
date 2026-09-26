// One-off: apply drizzle/E-310_ai_call_logs_end_reason.sql to the DB in
// DATABASE_URL, twice (second pass must be a no-op), then verify on a FRESH
// connection (postgres.js unsafe() DDL is not undone by a rollback).
//   node --env-file=.env.local scripts/_apply-e310.mjs
import postgres from "postgres";
import { readFileSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
console.log("host:", new URL(url).hostname);

const file = readFileSync(new URL("../drizzle/E-310_ai_call_logs_end_reason.sql", import.meta.url), "utf8");

const a = postgres(url, { ssl: { rejectUnauthorized: false }, max: 1, onnotice: (n) => console.log("notice:", n.message) });
await a.unsafe(file);
await a.unsafe(file);
await a.end();
console.log("applied twice");

const b = postgres(url, { ssl: { rejectUnauthorized: false }, max: 1 });
const cols = await b`
    SELECT column_name, data_type FROM information_schema.columns
     WHERE table_name = 'ai_call_logs' AND column_name IN ('end_reason', 'answered_by_voicemail')
     ORDER BY column_name`;
console.log(cols);
await b.end();
if (cols.length !== 2) process.exit(1);
