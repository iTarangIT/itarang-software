// Read-only: WHO would a journey push for this lead reach — the dealer or the
// customer?
//
// A lead a dealer created in their WhatsApp console is the dealer's file to run,
// so resolveLeadTarget() (src/lib/whatsapp/lead-push.ts) looks for the owning
// dealer's chat first and only falls back to the customer when there isn't one.
// This prints the same decision from raw SQL, without sending anything, so a
// "the co-borrower request went to the wrong number" report can be settled
// before anyone reads the code.
//
//   node --import tsx --env-file=.env.local scripts/_verify-lead-push-target.ts <LEAD-ID>

import postgres from "postgres";

const leadId = process.argv[2];
if (!leadId) throw new Error("usage: … _verify-lead-push-target.ts <LEAD-ID>");

/** Same normalisation as toWaPhone(): Meta addresses are E.164 without the '+'. */
function toWaPhone(input: string | null | undefined): string | null {
  const digits = (input ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return digits;
  return null;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
  console.log("HOST:", new URL(url).hostname);
  console.log("LEAD:", leadId, "\n");

  const [lead] = await sql`
    SELECT id, reference_id, full_name, owner_name, dealer_id,
           mobile, phone, owner_contact, source_channel, kyc_status
      FROM leads WHERE id = ${leadId}`;
  if (!lead) {
    console.log("Lead not found.");
    await sql.end();
    return;
  }

  const customerPhone = toWaPhone(lead.phone ?? lead.mobile ?? lead.owner_contact);
  console.log("customer       :", lead.full_name || lead.owner_name || "(unnamed)");
  console.log("customer phone :", customerPhone ?? "(none usable)");
  console.log("dealer_id      :", lead.dealer_id ?? "(null)");
  console.log("source_channel :", lead.source_channel ?? "(null)");

  const houseEmail = (
    process.env.WHATSAPP_HOUSE_DEALER_EMAIL || "dealer@itarang.com"
  ).toLowerCase();
  const [house] = await sql`
    SELECT dealer_id FROM users
     WHERE lower(email) = ${houseEmail} AND is_active = true LIMIT 1`;
  const isHouse =
    Boolean(house?.dealer_id) && house?.dealer_id === lead.dealer_id;
  console.log(
    "house dealer   :",
    house?.dealer_id ?? "(unresolved)",
    isHouse ? "→ this lead is customer self-onboarded" : "",
  );

  // Both routes a dealer can be reached by, exactly as dealerChannelForLead does.
  const dealerPhones: string[] = [];
  let dealerName: string | null = null;
  if (lead.dealer_id && !isHouse) {
    // Every approved application, not the first: one dealer_code can carry more
    // than one, and the newest of those may be the one with a null wa_phone.
    const apps = await sql`
      SELECT wa_phone, owner_name, company_name
        FROM dealer_onboarding_applications
       WHERE dealer_code = ${lead.dealer_id}
         AND onboarding_status = 'approved'
         AND dealer_account_status = 'active'
       ORDER BY created_at DESC`;
    const [d] = await sql`
      SELECT owner_phone, owner_name, company_name
        FROM dealers
       WHERE dealer_id = ${lead.dealer_id} AND onboarding_status = 'active'
       LIMIT 1`;
    for (const p of [...apps.map((a) => a.wa_phone), d?.owner_phone]) {
      const wa = toWaPhone(p);
      if (wa && !dealerPhones.includes(wa)) dealerPhones.push(wa);
    }
    const app = apps.find((a) => a.wa_phone) ?? apps[0];
    dealerName =
      d?.owner_name || app?.owner_name || d?.company_name || app?.company_name || null;
  }
  console.log("dealer         :", dealerName ?? "(none)");
  console.log("dealer phones  :", dealerPhones.length ? dealerPhones.join(", ") : "(none)");

  const dealerSessions = dealerPhones.length
    ? await sql`
        SELECT id, wa_phone, session_kind, current_state, last_inbound_at
          FROM whatsapp_onboarding_sessions
         WHERE wa_phone = ANY(${dealerPhones}) AND session_kind <> 'operator_file'
         ORDER BY CASE WHEN session_kind = 'dealer' THEN 0 ELSE 1 END,
                  last_inbound_at DESC NULLS LAST`
    : [];

  console.log(`\nDealer chats: ${dealerSessions.length}`);
  for (const s of dealerSessions) {
    console.log(`  ${s.wa_phone} [${s.session_kind}] state=${s.current_state}`);
  }

  const pointer = await sql`
    SELECT id, wa_phone, session_kind, current_state
      FROM whatsapp_onboarding_sessions
     WHERE context -> 'lead' ->> 'leadId' = ${leadId}
     ORDER BY updated_at DESC`;
  console.log(`\nSessions pointing at this lead: ${pointer.length}`);
  for (const s of pointer) {
    console.log(`  ${s.wa_phone} [${s.session_kind}] state=${s.current_state}`);
  }

  const customerSessions = customerPhone
    ? await sql`
        SELECT id, wa_phone, session_kind, current_state
          FROM whatsapp_onboarding_sessions
         WHERE wa_phone = ${customerPhone} AND session_kind <> 'operator_file'
         ORDER BY last_inbound_at DESC NULLS LAST`
    : [];
  console.log(`\nCustomer chats: ${customerSessions.length}`);

  console.log("\n--- VERDICT ---");
  if (dealerSessions.length > 0) {
    console.log(
      `DEALER — ${dealerName ?? "the dealer"} on ${dealerSessions[0].wa_phone}.`,
      "\nThe dealer runs every step; the customer's own number is not messaged.",
    );
  } else if (pointer.length > 0 || customerSessions.length > 0) {
    const chat = pointer[0] ?? customerSessions[0];
    console.log(
      `CUSTOMER — ${chat.wa_phone}.`,
      dealerPhones.length
        ? "\nThe owning dealer has a phone but no WhatsApp chat, so we do not cold-template them."
        : "\nNo dealer channel at all (house dealer, or no phone on file).",
    );
  } else if (customerPhone) {
    console.log(`COLD — template only to ${customerPhone}; no chat exists yet.`);
  } else {
    console.log("NONE — unreachable: no chat and no usable phone number.");
  }

  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
