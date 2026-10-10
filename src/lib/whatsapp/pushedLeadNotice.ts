// ID 33 — tell a dealer on WhatsApp that iTarang created a lead for them.
//
// When the iTarang team fills New Lead Step 1 with a dealer's mobile number,
// the lead is created under that dealer (src/app/api/leads/create/route.ts).
// The dealer then finds it in their WhatsApp console under *Save Drafts* (see
// inConsoleScope in ./customer-lead) — this message is how they learn it is
// there. Same routing as the dealer stage updates (notifications/emit.ts):
// only a dealer who already has a chat with us hears it; the copy is
// dealer-worded, so it is never sent to the customer instead.
import { pushToLead, resolveLeadTarget } from "./lead-push";
import { pushedLeadNoticeBody } from "./pushedLeads";

/**
 * Best-effort, never throws: the lead is already committed when this runs, and
 * a WhatsApp hiccup must not turn a successful create into an error.
 */
export async function notifyDealerOfPushedLead(leadId: string): Promise<void> {
  try {
    const target = await resolveLeadTarget(leadId);
    if (!target || target.audience !== "dealer") return;

    const result = await pushToLead(leadId, (t) => ({
      prompt: { kind: "text", body: pushedLeadNoticeBody(t) },
      nudge: {
        template: "lead_action",
        params: [t.greetName, t.referenceId, "continue the new lead iTarang added for you"],
      },
    }));
    console.log(`[WhatsApp/pushed-lead] notice lead=${leadId}: ${result}`);
  } catch (err) {
    console.error(`[WhatsApp/pushed-lead] notice for ${leadId} failed:`, err);
  }
}
