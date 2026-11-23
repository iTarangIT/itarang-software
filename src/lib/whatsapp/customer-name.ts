/**
 * Write the customer's name onto a WhatsApp lead — both full_name (what the
 * sale and warranty read) and owner_name (what list views fall back to).
 *
 * A WhatsApp lead is created with the "Customer" placeholder; the real name
 * comes from the PAN / Aadhaar (finance) or is typed (cash). The dealer-check
 * alert is NOT sent from here — it goes when the salesperson submits the file
 * (noticeDealerCheckSubmitted), by which time the name is known.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";

export async function setCustomerLeadName(leadId: string, name: string): Promise<void> {
  const clean = name.trim();
  if (!clean) return;
  await db
    .update(leads)
    .set({ full_name: clean, owner_name: clean, updated_at: new Date() })
    .where(eq(leads.id, leadId));
}
