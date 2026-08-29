/**
 * E-275 — telling the dealer that iTarang recalled (or resubmitted) a file.
 *
 * Admin pulls a file back from the lender to fix something, then sends it
 * again. Both moves are admin-side; the dealer only needs to hear about them,
 * so this module is push-only — no state, no handler, no button. The text is
 * addressed to the OWNING DEALER's chat: `pushToLead` resolves to the dealer's
 * channel first, and the copy is written for that audience.
 *
 * Called via dynamic import from the admin recall/resubmit routes; keep the
 * signature stable.
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { leads } from "@/lib/db/schema";

import { pushToLead } from "./lead-push";
import { oneLine } from "./window";

export async function pushRecallToWhatsApp(
  leadId: string,
  opts: {
    kind: "recalled" | "resubmitted";
    note?: string | null;
    nbfcName?: string | null;
  },
): Promise<void> {
  const [lead] = await db
    .select({
      full_name: leads.full_name,
      owner_name: leads.owner_name,
      mobile: leads.mobile,
      phone: leads.phone,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return;

  const name = lead.full_name || lead.owner_name || "Customer";
  const mobile = lead.mobile || lead.phone || "—";
  const fileLine = `File: ${name} · ${mobile}`;
  const note = (opts.note ?? "").trim();

  const body =
    opts.kind === "recalled"
      ? `📌 *File recalled by iTarang, changes being made.*\n\n${fileLine}` +
        (note ? `\nNote: ${note}` : "")
      : `✅ *File resubmitted.*\n\n${fileLine}\n` +
        `Your customer's file is back with ${opts.nbfcName ?? "the lender"}.`;

  await pushToLead(leadId, (t) => ({
    prompt: { kind: "text", body },
    nudge: {
      template: "lead_action",
      params: [
        oneLine(t.greetName),
        oneLine(t.referenceId),
        opts.kind === "recalled"
          ? `${t.customerName}'s file was recalled by iTarang`
          : `${t.customerName}'s file was resubmitted`,
      ],
    },
  }));
}
