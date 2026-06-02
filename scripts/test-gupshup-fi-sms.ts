/**
 * Throwaway: verify Gupshup SMS actually delivers the FI link.
 *
 *   npx tsx scripts/test-gupshup-fi-sms.ts "Akshar pandit test"
 *   npx tsx scripts/test-gupshup-fi-sms.ts 9XXXXXXXXX        (explicit number)
 *
 * Loads .env.local, resolves the destination (an FI-agent name → its phone, or a
 * raw 10-digit number), and POSTs a real SMS through the same Gupshup path the FI
 * dispatch uses. Prints the raw Gupshup response so we can see ok / messageId /
 * any DLT-template rejection.
 */
import "dotenv/config";
import { config } from "dotenv";
config({ path: ".env.local" });

import postgres from "postgres";

async function resolvePhone(arg: string): Promise<{ phone: string; label: string }> {
  const digits = arg.replace(/\D/g, "");
  if (digits.length >= 10) return { phone: digits, label: `raw number ${arg}` };

  // Treat arg as an agent name; look it up in nbfc_fi_agents.
  const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", prepare: false, max: 1 });
  try {
    const rows = await sql<{ name: string; phone: string }[]>`
      select name, phone from nbfc_fi_agents
      where lower(name) = lower(${arg}) order by created_at desc limit 1`;
    if (!rows.length) throw new Error(`No FI agent named "${arg}" found.`);
    return { phone: rows[0].phone, label: `agent "${rows[0].name}"` };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function sendGupshup(mobile: string, message: string) {
  const apiKey = process.env.GUPSHUP_API_KEY!;
  const appName = process.env.GUPSHUP_APP_NAME!;
  const source = process.env.GUPSHUP_SOURCE!;
  const channel = (process.env.GUPSHUP_CHANNEL || "sms").toLowerCase();
  const templateId = process.env.GUPSHUP_TEMPLATE_ID;

  const d = mobile.replace(/\D/g, "");
  const destination = d.length === 10 ? `91${d}` : d;

  const form = new URLSearchParams();
  form.set("source", source);
  form.set("destination", destination);
  form.set("src.name", appName);
  let endpoint: string;
  if (templateId) {
    form.set("template", JSON.stringify({ id: templateId, params: [message] }));
    endpoint = "https://api.gupshup.io/wa/api/v1/template/msg";
  } else {
    form.set("channel", channel);
    form.set("message", channel === "whatsapp" ? JSON.stringify({ type: "text", text: message }) : message);
    endpoint = process.env.GUPSHUP_ENDPOINT || "https://api.gupshup.io/wa/api/v1/msg";
  }

  console.log(`\n[test] POST ${endpoint}`);
  console.log(`[test] channel=${channel} template=${templateId ? "yes" : "no(free-text)"} to=${destination}`);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { apikey: apiKey, "Content-Type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });
  const data = await res.json().catch(() => ({}));
  console.log(`[test] HTTP ${res.status}`);
  console.log(`[test] response:`, JSON.stringify(data, null, 2));
  const status = String((data as any)?.status ?? "").toLowerCase();
  const ok = res.ok && (status === "submitted" || status === "success");
  console.log(`\n[test] VERDICT: ${ok ? "✅ Gupshup ACCEPTED the SMS" : "❌ Gupshup REJECTED / not submitted"}`);
  if (ok) console.log(`[test] NOTE: "submitted" means Gupshup queued it — confirm the handset actually receives it (DLT routing).`);
}

(async () => {
  const arg = process.argv[2];
  if (!arg) {
    console.error('Usage: npx tsx scripts/test-gupshup-fi-sms.ts "<agent name>" | <10-digit number>');
    process.exit(1);
  }
  if (process.env.SMS_PROVIDER !== "gupshup") {
    console.warn(`[test] WARNING: SMS_PROVIDER=${process.env.SMS_PROVIDER} (FI dispatch would NOT use Gupshup). Testing Gupshup directly anyway.`);
  }
  const { phone, label } = await resolvePhone(arg);
  console.log(`[test] sending to ${label} → ${phone}`);
  await sendGupshup(phone, `iTarang FI test: field verification link. If you got this SMS, Gupshup delivery works.`);
})().catch((e) => {
  console.error("[test] FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
