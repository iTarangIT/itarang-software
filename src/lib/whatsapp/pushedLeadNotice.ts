// ID 33 — tell a dealer on WhatsApp that iTarang created a lead for them.
//
// When the iTarang team fills New Lead Step 1 with a dealer's mobile number,
// the lead is created under that dealer (src/app/api/leads/create/route.ts).
// The dealer then finds it in their WhatsApp console under *Save Drafts* (see
// inConsoleScope in ./customer-lead) — this message is how they learn it is
// there. The copy is dealer-worded, so it is never sent to the customer.
//
// 16 Oct (ID 33 / 182):
//   * the push reason goes into the bell + email (it was accepted but dropped);
//   * a dealer with no open chat gets the approved `lead_action` template on
//     their own number (pushToLeadDealer) instead of nothing;
//   * when an admin moves a file from one dealer to another, the dealer who
//     LOSES it is told too (notifyDealerOfPushAway).
import { pushToLeadDealer } from "./lead-push";
import { pushedLeadNoticeBody } from "./pushedLeads";

/**
 * Best-effort, never throws: the lead is already committed when this runs, and
 * a WhatsApp hiccup must not turn a successful create into an error.
 */
export async function notifyDealerOfPushedLead(
  leadId: string,
  opts: {
    /** The push reason, shown to the receiving dealer. */
    reason?: string | null;
    /** The dealer the file left (leads.dealer_id before the push). */
    fromDealerId?: string | null;
  } = {},
): Promise<void> {
  // 14 Oct: bell + email too, so a dealer with no WhatsApp chat still hears.
  const { notifyDealerOfPush, notifyDealerOfPushAway } = await import("@/lib/leads/pushNotices");
  await notifyDealerOfPush(leadId, opts.reason ?? null);
  try {
    const result = await pushToLeadDealer(leadId, (t) => ({
      prompt: { kind: "text", body: pushedLeadNoticeBody(t) },
      nudge: {
        template: "lead_action",
        params: [t.customerName, t.referenceId, "continue the new lead iTarang added for you"],
      },
    }));
    console.log(`[WhatsApp/pushed-lead] notice lead=${leadId}: ${result}`);
  } catch (err) {
    console.error(`[WhatsApp/pushed-lead] notice for ${leadId} failed:`, err);
  }
  if (opts.fromDealerId) await notifyDealerOfPushAway(leadId, opts.fromDealerId);
}
