/**
 * Local manual test for the NBFC wallet INFLOW webhook + §16.3 idempotency.
 *
 * Crafts a signature-verified `virtual_account.credited` event (no Razorpay
 * needed), POSTs it to the running dev server TWICE, and reads the DB before/
 * after to prove: the balance is credited EXACTLY ONCE and the second (replayed)
 * delivery is a no-op.
 *
 * Prereqs: dev server running (npm run dev) on PORT (default 3000), and
 * RAZORPAY_WEBHOOK_SECRET set in .env.local (the same secret the route verifies).
 *
 *   node scripts/test-wallet-webhook.mjs [tenantId] [amountRupees]
 *
 * With no tenantId it auto-picks the first nbfc_tenants row.
 */
import postgres from "postgres";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

function fromEnvFile(key) {
  if (process.env[key]) return process.env[key];
  try {
    const env = readFileSync(join(root, ".env.local"), "utf8");
    for (const line of env.split(/\r?\n/)) {
      const m = line.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+)\\s*$`));
      if (m) return m[1].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return undefined;
}

const DATABASE_URL = fromEnvFile("DATABASE_URL");
const WEBHOOK_SECRET = fromEnvFile("RAZORPAY_WEBHOOK_SECRET");
const PORT = fromEnvFile("PORT") || "3000";
const BASE = `http://localhost:${PORT}`;

if (!DATABASE_URL) throw new Error("DATABASE_URL not found");
if (!WEBHOOK_SECRET) throw new Error("RAZORPAY_WEBHOOK_SECRET not found in .env.local — the route can't verify the signature without it");

const argTenant = process.argv[2];
const amountRupees = Number(process.argv[3] || 50000);
const amountPaise = Math.round(amountRupees * 100);

const sql = postgres(DATABASE_URL, { ssl: "require", prepare: false, max: 1, connect_timeout: 15, onnotice: () => {} });

const num = (v) => Number(v ?? 0);

try {
  // 1) Resolve a tenant.
  let tenantId = argTenant;
  if (!tenantId) {
    const [t] = await sql`SELECT id, display_name FROM nbfc_tenants ORDER BY created_at LIMIT 1`;
    if (!t) throw new Error("No nbfc_tenants rows — pass a tenantId explicitly");
    tenantId = t.id;
    console.log(`[test] auto-picked tenant: ${t.display_name} (${tenantId})`);
  } else {
    console.log(`[test] tenant: ${tenantId}`);
  }

  // 2) Balance + counts BEFORE.
  const before = await readState(tenantId);
  console.log(`[before] balance=₹${before.balance}  ledger_topups=${before.topups}  inflows=${before.inflows}`);

  // 3) Build + sign a virtual_account.credited event. One stable event id per run
  //    so the two POSTs share it (that's what proves dedupe).
  const eventId = `pay_test_${Date.now()}`;
  const body = JSON.stringify({
    event: "virtual_account.credited",
    payload: {
      payment: { entity: { id: eventId, amount: amountPaise, currency: "INR", status: "captured", notes: {} } },
      virtual_account: {
        entity: { id: "va_test_local", notes: { itarang_tenant_id: tenantId, itarang_nbfc_id: "0" } },
      },
    },
  });
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");

  // 4) POST twice.
  const r1 = await postWebhook(body, signature);
  console.log(`[post #1] HTTP ${r1.status} → ${JSON.stringify(r1.json)}`);
  const r2 = await postWebhook(body, signature);
  console.log(`[post #2 replay] HTTP ${r2.status} → ${JSON.stringify(r2.json)}`);

  // 5) Balance + counts AFTER.
  const after = await readState(tenantId);
  console.log(`[after]  balance=₹${after.balance}  ledger_topups=${after.topups}  inflows=${after.inflows}`);

  // 6) Assertions.
  const creditedOnce = num(after.balance) - num(before.balance) === amountRupees;
  const oneLedger = after.topups - before.topups === 1;
  const oneInflow = after.inflows - before.inflows === 1;
  const replayIdempotent = r2.json?.idempotent === true;
  console.log("\n=== RESULT ===");
  console.log(`balance credited by exactly ₹${amountRupees}: ${creditedOnce ? "PASS" : "FAIL"}`);
  console.log(`exactly one topup ledger line added:          ${oneLedger ? "PASS" : "FAIL"}`);
  console.log(`exactly one inflow row added:                 ${oneInflow ? "PASS" : "FAIL"}`);
  console.log(`replayed delivery was idempotent (no credit): ${replayIdempotent ? "PASS" : "FAIL"}`);
  const ok = creditedOnce && oneLedger && oneInflow && replayIdempotent;
  console.log(ok ? "\n✅ ALL PASS — money-in credit is correct and idempotent." : "\n❌ Some checks failed — see above.");
} catch (e) {
  console.error("[test] error:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}

async function readState(tenantId) {
  const [w] = await sql`SELECT balance FROM nbfc_wallets WHERE tenant_id = ${tenantId} LIMIT 1`;
  const [lt] = await sql`SELECT count(*)::int AS c FROM nbfc_wallet_ledger WHERE tenant_id = ${tenantId} AND kind = 'topup'`;
  const [inf] = await sql`SELECT count(*)::int AS c FROM nbfc_wallet_inflows WHERE tenant_id = ${tenantId}`;
  return { balance: num(w?.balance), topups: lt?.c ?? 0, inflows: inf?.c ?? 0 };
}

async function postWebhook(body, signature) {
  const res = await fetch(`${BASE}/api/payments/razorpay/wallet-webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-razorpay-signature": signature },
    body,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
