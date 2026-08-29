/**
 * E-275 — "Up to how much loan do you want?"
 *
 * Asked once per lead after KYC / co-borrower and BEFORE the lender list, on
 * both the web product-selection page and the WhatsApp Step-4 flow. Stored on
 * `leads.requested_loan_amount`; `loadSectionGOptions(lead, amount)` then
 * hides every product whose `loan_amount_max` is below it (see bre/match.ts).
 *
 * Pure parsing lives here too so the web input and the WhatsApp reply agree
 * on what "60k", "₹ 1,20,000" and "1.5 lakh" mean.
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";

export {
  MIN_REQUESTED_LOAN,
  MAX_REQUESTED_LOAN,
  parseRupees,
  formatRupees,
} from "@/lib/leads/requested-loan-amount-parse";
import {
  MIN_REQUESTED_LOAN,
  MAX_REQUESTED_LOAN,
} from "@/lib/leads/requested-loan-amount-parse";

/** Persist the amount. Returns false when the lead row does not exist. */
export async function setRequestedLoanAmount(
  leadId: string,
  amount: number,
): Promise<boolean> {
  if (
    !Number.isInteger(amount) ||
    amount < MIN_REQUESTED_LOAN ||
    amount > MAX_REQUESTED_LOAN
  ) {
    throw new Error("requested loan amount out of range");
  }
  const rows = await db
    .update(leads)
    .set({ requested_loan_amount: amount, updated_at: new Date() })
    .where(eq(leads.id, leadId))
    .returning({ id: leads.id });
  return rows.length > 0;
}

export async function getRequestedLoanAmount(leadId: string): Promise<number | null> {
  const [row] = await db
    .select({ amount: leads.requested_loan_amount })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  return row?.amount ?? null;
}
