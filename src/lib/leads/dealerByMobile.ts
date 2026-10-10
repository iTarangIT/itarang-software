// Tracker ID 33 — find the ACTIVE onboarded dealer behind a mobile number, so
// an internal (iTarang-team) Step-1 submission can be created under that
// dealer instead of the house dealer. See ./pushToDealer for the pure rules.
//
// "Active" is the same test /api/leads/create's E-105 gate applies to the
// dealer itself: a dealers row with onboarding_status = 'active' whose type
// sells new batteries. The number may be the owner's mobile on the dealers
// row, the mobile of the dealer's login (users.phone — users.dealer_id is the
// dealer code = accounts.id), or one of the dealer's extra WhatsApp main
// numbers (E-279). The house dealer itself is never a push target.

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { accounts, dealerExtraNumbers, dealers, users } from "@/lib/db/schema";
import { capabilitiesFor } from "@/lib/dealer/dealer-capabilities";
import { resolveHouseDealer } from "@/lib/whatsapp/customer-lead";

import { tenDigitMobile } from "./pushToDealer";

export interface PushTargetDealer {
  /** dealer code = dealers.dealer_id = accounts.id = leads.dealer_id */
  dealerId: string;
  name: string;
  financeEnabled: boolean;
}

export type DealerByMobileResult =
  | { status: "found"; dealer: PushTargetDealer }
  | { status: "invalid_mobile" }
  | { status: "not_found" }
  | { status: "ambiguous" };

/** The house dealer's code (users.dealer_id of dealer@itarang.com), or null. */
export async function houseDealerCode(): Promise<string | null> {
  try {
    return (await resolveHouseDealer())?.dealerCode ?? null;
  } catch (err) {
    console.error("[dealerByMobile] house dealer lookup failed:", err);
    return null;
  }
}

const digits10 = (col: unknown) =>
  sql`right(regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g'), 10)`;

export async function findActiveDealerByMobile(
  mobile: string | null | undefined,
): Promise<DealerByMobileResult> {
  const ten = tenDigitMobile(mobile);
  if (!ten) return { status: "invalid_mobile" };

  const house = await houseDealerCode();

  const [byOwner, byLogin, byExtra] = await Promise.all([
    db
      .select({ code: dealers.dealer_id })
      .from(dealers)
      .where(sql`${digits10(dealers.owner_phone)} = ${ten}`),
    db
      .select({ code: users.dealer_id })
      .from(users)
      .where(
        and(
          eq(users.role, "dealer"),
          eq(users.is_active, true),
          sql`${users.dealer_id} IS NOT NULL`,
          sql`${digits10(users.phone)} = ${ten}`,
        ),
      ),
    // E-279 extra numbers; tolerate a DB where the table is not there yet.
    db
      .select({ code: dealerExtraNumbers.dealer_code })
      .from(dealerExtraNumbers)
      .where(
        and(
          eq(dealerExtraNumbers.is_active, true),
          sql`${digits10(dealerExtraNumbers.wa_phone)} = ${ten}`,
        ),
      )
      .catch(() => [] as { code: string | null }[]),
  ]);

  const codes = Array.from(
    new Set(
      [...byOwner, ...byLogin, ...byExtra]
        .map((r) => r.code)
        .filter((c): c is string => !!c && c !== house),
    ),
  );
  if (codes.length === 0) return { status: "not_found" };

  const rows = await db
    .select({
      dealerId: dealers.dealer_id,
      companyName: dealers.company_name,
      onboardingStatus: dealers.onboarding_status,
      financeEnabled: dealers.finance_enabled,
      dealerType: dealers.dealer_type,
    })
    .from(dealers)
    .where(inArray(dealers.dealer_id, codes));

  const active = rows.filter(
    (r) =>
      !!r.dealerId &&
      r.onboardingStatus === "active" &&
      capabilitiesFor(r.dealerType).newBattery,
  );
  if (active.length === 0) return { status: "not_found" };
  if (active.length > 1) return { status: "ambiguous" };

  const d = active[0];
  // Prefer the legal-entity name the rest of the CRM shows for this dealer.
  const [acc] = await db
    .select({ name: accounts.business_entity_name })
    .from(accounts)
    .where(eq(accounts.id, d.dealerId!))
    .limit(1);

  return {
    status: "found",
    dealer: {
      dealerId: d.dealerId!,
      name: acc?.name || d.companyName,
      financeEnabled: Boolean(d.financeEnabled),
    },
  };
}
