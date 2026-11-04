// One-off: apply E-371 (emi_customer_messages.kind takes the SMS-plan kinds:
// sms_before, sms_due_today, sms_overdue) to database-1 (sandbox) or
// database-2 (prod).
//
//   node scripts/_apply-e371.mjs database-1
//   node scripts/_apply-e371.mjs database-2
//
// Widens one CHECK only. Reads that host's URL from .env.local (commented or
// not), never prints it. Applies the file twice (the second pass must be a
// no-op), then re-checks the constraint on a FRESH connection.
import postgres from "postgres";
import { readFileSync } from "node:fs";

const target = process.argv[2];
if (!["database-1", "database-2"].includes(target)) throw new Error("usage: database-1 | database-2");
const line = readFileSync(process.env.ENV_FILE ?? ".env.local", "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*#?\s*DATABASE_URL=/.test(l) && l.includes(`${target}.`));
if (!line) throw new Error(`no DATABASE_URL for ${target} in .env.local`);
const url = line.replace(/^\s*#?\s*DATABASE_URL=/, "").trim().replace(/^["']|["']$/g, "");
const host = new URL(url).host;
if (!host.startsWith(`${target}.`)) throw new Error(`host mismatch: ${host}`);
console.log("target:", host.split(".")[0]);

const file = readFileSync("drizzle/E-371_emi_sms_plan_kinds.sql", "utf8");
const opts = { max: 1, prepare: false, ssl: { rejectUnauthorized: false } };

const sql = postgres(url, { ...opts, onnotice: (n) => console.log("notice:", n.message) });
try {
  for (const pass of [1, 2]) {
    await sql.begin((tx) => tx.unsafe(file));
    console.log(`pass ${pass}: ok`);
  }
} finally {
  await sql.end();
}

const check = postgres(url, opts);
try {
  const [c] = await check`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conname = 'emi_customer_messages_kind_chk'`;
  if (!c) throw new Error("emi_customer_messages_kind_chk missing (is E-365 applied?)");
  for (const k of ["received", "reminder", "sms_before", "sms_due_today", "sms_overdue"]) {
    if (!c.def.includes(`'${k}'`)) throw new Error(`kind check does not take ${k}`);
  }
  console.log("E-371 verified: kind check takes sms_before / sms_due_today / sms_overdue");
} finally {
  await check.end();
}
