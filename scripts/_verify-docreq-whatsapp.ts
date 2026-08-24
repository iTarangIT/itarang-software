// Read-only: can an admin document request for this lead actually REACH anyone
// on WhatsApp right now?
//
// Three things have to line up, and each fails differently:
//   1. a session whose context.lead.leadId is this lead  -> else we go "cold"
//   2. that session inside Meta's 24-hour window          -> else template only
//   3. an approved template when it is outside            -> else silence
//
//   node --import tsx --env-file=.env.local scripts/_verify-docreq-whatsapp.ts <LEAD-ID>

import postgres from "postgres";

const leadId = process.argv[2];
if (!leadId) throw new Error("usage: … _verify-docreq-whatsapp.ts <LEAD-ID>");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { ssl: "require", prepare: false, max: 1 });
  console.log("HOST:", new URL(url).hostname);
  console.log("LEAD:", leadId, "\n");

  const [lead] = await sql`
    SELECT id, reference_id, full_name, owner_name, mobile, phone, owner_contact,
           source_channel, kyc_status, dealer_id, assignment_status
      FROM leads WHERE id = ${leadId}`;
  if (!lead) {
    console.log("Lead not found.");
    await sql.end();
    return;
  }
  console.log("source_channel :", lead.source_channel ?? "(null)");
  console.log("kyc_status     :", lead.kyc_status);
  console.log("customer phone :", lead.mobile ?? lead.phone ?? lead.owner_contact ?? "(none)");

  const reqs = await sql`
    SELECT id, doc_label, doc_for, upload_status, uploaded_at, token_expires_at
      FROM other_document_requests
     WHERE lead_id = ${leadId}
     ORDER BY created_at DESC`;
  console.log(`\nDocument requests: ${reqs.length}`);
  for (const r of reqs) {
    console.log(
      `  ${r.upload_status === "uploaded" ? "[done]" : "[open]"} ${r.doc_label}`,
      `(${r.doc_for})`,
      r.uploaded_at ? `uploaded ${r.uploaded_at.toISOString()}` : "",
    );
  }

  const sessions = await sql`
    SELECT id, wa_phone, current_state, session_kind, last_inbound_at,
           window_nudges_sent, pending_prompt IS NOT NULL AS has_parked
      FROM whatsapp_onboarding_sessions
     WHERE context -> 'lead' ->> 'leadId' = ${leadId}
     ORDER BY updated_at DESC`;

  console.log(`\nWhatsApp sessions driving this lead: ${sessions.length}`);
  if (sessions.length === 0) {
    console.log("  -> pushToLead() would go COLD (template only, no chat to park in).");
  }
  const WINDOW_MS = 24 * 60 * 60 * 1000 - 5 * 60 * 1000;
  for (const s of sessions) {
    const age = s.last_inbound_at
      ? Date.now() - new Date(s.last_inbound_at).getTime()
      : null;
    const open = age !== null && age < WINDOW_MS;
    console.log(
      `  ${s.wa_phone}  state=${s.current_state}  kind=${s.session_kind}`,
      `\n     last inbound: ${s.last_inbound_at ? new Date(s.last_inbound_at).toISOString() : "never"}`,
      `\n     24h window: ${open ? "OPEN -> the real prompt sends now" : "SHUT -> prompt parks, template nudge needed"}`,
      `\n     parked prompt already waiting: ${s.has_parked}`,
    );
  }

  // Mirrors findSessionByLeadPhone(): the fallback that matters, because a
  // submitted lead has no ctx.lead pointer left to find it by.
  const phones = [lead.mobile, lead.phone, lead.owner_contact]
    .map((v: string | null) => {
      const d = (v ?? "").replace(/\D/g, "");
      if (d.length === 10) return `91${d}`;
      if (d.length === 12 && d.startsWith("91")) return d;
      return null;
    })
    .filter((v): v is string => Boolean(v));

  if (sessions.length === 0 && phones.length) {
    const byPhone = await sql`
      SELECT id, wa_phone, current_state, session_kind, last_inbound_at
        FROM whatsapp_onboarding_sessions
       WHERE wa_phone = ANY(${sql.array([...new Set(phones)])})
         AND session_kind <> 'operator_file'
       ORDER BY CASE WHEN session_kind = 'dealer' THEN 0 ELSE 1 END,
                last_inbound_at DESC
       LIMIT 1`;
    console.log("\nPhone fallback (findSessionByLeadPhone):");
    if (byPhone.length === 0) {
      console.log("  no usable session for", [...new Set(phones)].join(", "));
    } else {
      const s = byPhone[0];
      const age = s.last_inbound_at
        ? Date.now() - new Date(s.last_inbound_at).getTime()
        : null;
      const open = age !== null && age < WINDOW_MS;
      console.log(
        `  RESOLVED -> ${s.wa_phone} state=${s.current_state} kind=${s.session_kind}`,
        `\n     last inbound: ${s.last_inbound_at ? new Date(s.last_inbound_at).toISOString() : "never"}`,
        age !== null ? `(${Math.round(age / 60000)} min ago)` : "",
        `\n     24h window: ${open ? "OPEN -> free-form prompt sends immediately" : "SHUT -> parks, needs a template"}`,
      );
    }
  }

  const approved = (process.env.WA_TEMPLATES_APPROVED ?? "").trim();
  const override = (process.env.WA_LEAD_ACTION_TEMPLATE ?? "").trim();
  console.log("\nTemplate config:");
  console.log("  WA_TEMPLATES_APPROVED   :", approved || "(unset)");
  console.log("  WA_LEAD_ACTION_TEMPLATE :", override || "(unset)");
  if (!approved.split(",").map((s) => s.trim()).includes("lead_action") && !override) {
    console.log(
      "  -> No approved lead_action template. Out-of-window pushes will PARK SILENTLY",
      "\n     (delivered the moment the customer next messages). In-window pushes work.",
    );
  }

  await sql.end({ timeout: 5 });
}

void main();
