/**
 * Re-open the battery picker for chats that `askBattery` parked on DC_DP_WAIT
 * because the dealer had no stock at that moment.
 *
 * Nothing in the app moves those chats along on its own. The four paths that
 * allocate stock to a dealer (admin add-item, admin bulk-upload, dealer
 * acknowledge-transfer, legacy inventory/bulk-upload) know nothing about parked
 * conversations, so a customer who reached the picker one minute before their
 * dealer's stock landed sits on "your dealer is arranging stock" indefinitely.
 *
 * `onDispatchWait` now heals that on the customer's NEXT inbound message. This
 * script is the proactive half — run it after loading stock for a dealer.
 *
 * Usage (dry run — lists what WOULD be woken, sends nothing):
 *   node --env-file=.env.local --import tsx scripts/wake-parked-dispatch-chats.ts
 *   node --env-file=.env.local --import tsx scripts/wake-parked-dispatch-chats.ts -- --dealer <ACC-...>
 *   node --env-file=.env.local --import tsx scripts/wake-parked-dispatch-chats.ts -- --lead <LEAD-...>
 *
 * Add `--send` to actually deliver the WhatsApp messages. It is off by default
 * on purpose: this writes to real customer and dealer chats.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { desc, eq, sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import { leads, whatsappOnboardingSessions } from "../src/lib/db/schema";
import { listDealerBatteries } from "../src/lib/inventory/dealer-stock";
import { DC_DP_WAIT, pushStockReady } from "../src/lib/whatsapp/dispatch-flow";

type Args = { dealer?: string; lead?: string; send: boolean };

function parseArgs(): Args {
  const out: Args = { send: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dealer") out.dealer = argv[++i];
    else if (a === "--lead") out.lead = argv[++i];
    else if (a === "--send") out.send = true;
  }
  return out;
}

const leadIdExpr = sql`${whatsappOnboardingSessions.context} -> 'lead' ->> 'leadId'`;
const batterySerialExpr = sql`${whatsappOnboardingSessions.context} -> 'lead' -> 'dp' ->> 'batterySerial'`;

/**
 * `--lead` names one order explicitly, so it does NOT go through the session
 * scan.
 *
 * That is not a shortcut, it is the only thing that works. A chat parked on
 * DC_DP_WAIT loses its lead pointer the moment the customer sends "hi": the
 * greeting resets the session to DC_MENU and clears `context.lead`, so the
 * order that was waiting for stock becomes invisible to any scan keyed on
 * session context — precisely the orders most likely to need waking, since a
 * stuck customer is the one who tries messaging again.
 *
 * `pushToLead` falls back to matching the phone numbers on the lead itself, so
 * the message still reaches the right chat.
 */
async function wakeOne(leadId: string, send: boolean): Promise<boolean> {
  const [lead] = await db
    .select({ dealer_id: leads.dealer_id, kyc_status: leads.kyc_status, owner_name: leads.owner_name })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) {
    console.log(`  ✗ ${leadId} — no such lead`);
    return false;
  }
  if (!lead.dealer_id) {
    console.log(`  ✗ ${leadId} — no dealer on lead`);
    return false;
  }
  if (lead.kyc_status !== "loan_sanctioned") {
    console.log(`  ✗ ${leadId} — kyc_status '${lead.kyc_status}', not a sanctioned order awaiting pickup`);
    return false;
  }
  const batteries = await listDealerBatteries({ dealerId: lead.dealer_id });
  if (batteries.length === 0) {
    console.log(`  ✗ ${leadId} — dealer ${lead.dealer_id} has no available stock`);
    return false;
  }
  console.log(
    `  ▸ ${leadId} — ${lead.owner_name ?? "?"} · dealer ${lead.dealer_id} has ${batteries.length} available` +
      (send ? " — waking" : " — WOULD wake"),
  );
  if (!send) return true;
  const result = await pushStockReady(leadId);
  // "session"/"cold" mean routed, NOT delivered — sendOrPark swallows adapter
  // failures, so an expired META_WA_ACCESS_TOKEN still reports "session".
  // Confirm against whatsapp_messages.provider_message_id before believing it.
  console.log(`      → pushToLead: ${result}` + (result === "session" || result === "cold" ? " (routed — verify provider_message_id)" : ""));
  return result !== "skipped" && result !== "none";
}

async function main() {
  const args = parseArgs();

  if (args.lead) {
    if (!args.send) console.log("(dry run — pass --send to deliver)\n");
    const ok = await wakeOne(args.lead, args.send);
    console.log(`\n${args.send ? "Woken" : "Would wake"}: ${ok ? 1 : 0}`);
    process.exit(0);
  }

  const rows = await db
    .select({
      id: whatsappOnboardingSessions.id,
      wa_phone: whatsappOnboardingSessions.wa_phone,
      updated_at: whatsappOnboardingSessions.updated_at,
      lead_id: sql<string | null>`${leadIdExpr}`,
      battery_serial: sql<string | null>`${batterySerialExpr}`,
    })
    .from(whatsappOnboardingSessions)
    .where(eq(whatsappOnboardingSessions.current_state, DC_DP_WAIT))
    .orderBy(desc(whatsappOnboardingSessions.updated_at));

  console.log(`Sessions parked on ${DC_DP_WAIT}: ${rows.length}`);
  if (!args.send) console.log("(dry run — pass --send to deliver)\n");

  let woken = 0;
  for (const s of rows) {
    if (!s.lead_id) continue;
    if (args.lead && s.lead_id !== args.lead) continue;

    // `batterySerial` present means the customer already picked — this chat is
    // parked on a placed order, not on missing stock. Never re-open it.
    if (s.battery_serial) {
      console.log(`  – ${s.lead_id} (${s.wa_phone}) — already picked ${s.battery_serial}, skip`);
      continue;
    }

    const [lead] = await db
      .select({ dealer_id: leads.dealer_id, kyc_status: leads.kyc_status, owner_name: leads.owner_name })
      .from(leads)
      .where(eq(leads.id, s.lead_id))
      .limit(1);
    if (!lead?.dealer_id) {
      console.log(`  – ${s.lead_id} (${s.wa_phone}) — no dealer on lead, skip`);
      continue;
    }
    if (args.dealer && lead.dealer_id !== args.dealer) continue;
    if (lead.kyc_status !== "loan_sanctioned") {
      console.log(
        `  – ${s.lead_id} (${s.wa_phone}) — kyc_status '${lead.kyc_status}', not a sanctioned order, skip`,
      );
      continue;
    }

    const batteries = await listDealerBatteries({ dealerId: lead.dealer_id });
    if (batteries.length === 0) {
      console.log(`  – ${s.lead_id} (${s.wa_phone}) — dealer ${lead.dealer_id} still has no stock, skip`);
      continue;
    }

    console.log(
      `  ▸ ${s.lead_id} (${s.wa_phone}) — ${lead.owner_name ?? "?"} · dealer ${lead.dealer_id} has ` +
        `${batteries.length} available` + (args.send ? " — waking" : " — WOULD wake"),
    );
    if (args.send) {
      const result = await pushStockReady(s.lead_id);
      console.log(`      → pushToLead: ${result}`);
      if (result !== "skipped" && result !== "none") woken++;
    } else {
      woken++;
    }
  }

  console.log(`\n${args.send ? "Woken" : "Would wake"}: ${woken}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("✗", e instanceof Error ? e.message : e);
  process.exit(1);
});
