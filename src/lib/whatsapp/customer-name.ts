/**
 * Write the customer's name onto a WhatsApp lead (both full_name — what the
 * sale and warranty read — and owner_name — what list views fall back to).
 *
 * A WhatsApp lead is created with the "Customer" placeholder before the PAN /
 * Aadhaar is read. The first time a real name replaces it, the dealer-check
 * email + WhatsApp alert that was held back for it goes out (23 Nov:
 * "customer name should come properly"). The placeholder → name step is a
 * single conditional UPDATE, so when PAN and Aadhaar land together only one of
 * them sends the alert.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";

const PLACEHOLDERS = ["Customer", "DRAFT", ""];

export async function setCustomerLeadName(leadId: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  const now = new Date();

  const firstName = await db
    .update(leads)
    .set({ full_name: clean, owner_name: clean, updated_at: now })
    .where(and(eq(leads.id, leadId), or(isNull(leads.owner_name), inArray(leads.owner_name, PLACEHOLDERS))))
    .returning({ id: leads.id });

  if (firstName.length) {
    const { noticeDealerCheckNameArrived } = await import("@/lib/leads/dealer-check-notify");
    await noticeDealerCheckNameArrived(leadId);
    return;
  }

  // The name was already known — a later document just refreshes it.
  await db
    .update(leads)
    .set({ full_name: clean, owner_name: clean, updated_at: now })
    .where(eq(leads.id, leadId));
}
