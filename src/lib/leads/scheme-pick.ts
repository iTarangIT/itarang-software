/**
 * E-394 (23 Nov 2026, Battery Pool) — the iTarang admin / sales head chooses
 * the NBFC scheme (lender + loan product) BEFORE the lead is submitted, on
 * WhatsApp or on the web. Stored in lead_scheme_picks; resolveRoutingTarget()
 * (nbfc-routing.ts) prefers it over the routing rules while the product still
 * passes the BRE, so the file goes to that scheme when Step 4 opens.
 */
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { leadSchemePicks, leads, users } from "@/lib/db/schema";

import { loadSectionGOptions } from "./section-g";

/** Roles allowed to pick the scheme. */
export const SCHEME_PICK_ROLES: ReadonlySet<string> = new Set(["admin", "ceo", "business_head", "sales_head"]);

export function mayPickScheme(role: string | null | undefined): boolean {
  return SCHEME_PICK_ROLES.has(String(role ?? "").toLowerCase());
}

export async function roleOfUser(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.role ?? null;
}

export async function getLeadSchemePick(leadId: string) {
  const [row] = await db.select().from(leadSchemePicks).where(eq(leadSchemePicks.lead_id, leadId)).limit(1);
  return row ?? null;
}

export interface SchemeOption {
  nbfcId: number;
  loanProductId: number;
  /** "Battery Pool — 12 by 0" — staff see the lender's real name. */
  label: string;
  detail: string;
}

/** Every lender + product the BRE allows for this lead now (staff view). */
export async function listSchemeOptions(leadId: string): Promise<SchemeOption[]> {
  const [lead] = await db
    .select({
      dealer_id: leads.dealer_id,
      product_category_id: leads.product_category_id,
      state: leads.state,
      city: leads.city,
      resident_status: leads.resident_status,
      requested_loan_amount: leads.requested_loan_amount,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return [];
  const options = await loadSectionGOptions(
    lead,
    lead.requested_loan_amount != null ? Number(lead.requested_loan_amount) : null,
    { skipPinnedDefault: true },
  );
  const out: SchemeOption[] = [];
  for (const n of options) {
    for (const p of n.activeLoanProducts) {
      out.push({
        nbfcId: n.nbfcId,
        loanProductId: p.id,
        label: `${n.shortName || n.legalName} — ${p.productName}`,
        detail: `ROI ${p.minRoiPct}–${p.maxRoiPct}% · ${p.tenureMonthsMin}–${p.tenureMonthsMax} months · ₹${Number(
          p.loanAmountMin,
        ).toLocaleString("en-IN")}–₹${Number(p.loanAmountMax).toLocaleString("en-IN")}`,
      });
    }
  }
  return out;
}

export class SchemePickError extends Error {}

/** Save (or clear with null) the scheme for a lead. Validates against the BRE list. */
export async function setLeadSchemePick(opts: {
  leadId: string;
  pick: { nbfcId: number; loanProductId: number } | null;
  byUserId: string | null;
  byName: string | null;
  channel: "web" | "whatsapp";
}): Promise<{ label: string | null }> {
  if (!opts.pick) {
    await db.delete(leadSchemePicks).where(eq(leadSchemePicks.lead_id, opts.leadId));
    return { label: null };
  }
  const options = await listSchemeOptions(opts.leadId);
  const hit = options.find(
    (o) => o.nbfcId === opts.pick!.nbfcId && o.loanProductId === opts.pick!.loanProductId,
  );
  if (!hit) throw new SchemePickError("That scheme does not fit this lead (eligibility, amount, location or dealer)");
  const now = new Date();
  await db
    .insert(leadSchemePicks)
    .values({
      lead_id: opts.leadId,
      nbfc_id: hit.nbfcId,
      loan_product_id: hit.loanProductId,
      picked_by: opts.byUserId,
      picked_by_name: opts.byName,
      channel: opts.channel,
      picked_at: now,
    })
    .onConflictDoUpdate({
      target: leadSchemePicks.lead_id,
      set: {
        nbfc_id: hit.nbfcId,
        loan_product_id: hit.loanProductId,
        picked_by: opts.byUserId,
        picked_by_name: opts.byName,
        channel: opts.channel,
        picked_at: now,
      },
    });
  return { label: hit.label };
}
