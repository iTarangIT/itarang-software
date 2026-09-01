// E-277 — map an inbound WhatsApp number to a dealer's SALESPERSON.
//
// A salesperson is a member of a dealer's own team who onboards customers from
// their personal WhatsApp number on the dealer's behalf. Mirror image of the
// E-214 operator gate (one iTarang number → many dealers; here: many numbers →
// one dealer). This lookup separates them from ordinary senders in runTurn(),
// and — like resolveOperator — it MUST run before getOrCreateSession so a
// salesperson's first "hi" mints a `session_kind='salesperson'` row instead of
// a junk dealer-onboarding draft.
//
// Why an explicit allowlist table and not users: salespersons have NO users row
// at all (WhatsApp-only, no login). dealer_salespersons is dealer-managed (My
// Team chat menu / portal Team page), has its own activation switch, and one
// ACTIVE row per phone globally (partial unique index) so a number resolves to
// at most one dealer.

import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { dealers, dealerSalespersons, users } from "@/lib/db/schema";
import { phoneLookupVariants } from "@/lib/ai/phone";

import {
  type ActiveDealer,
  resolveDealerFinanceEnabled,
} from "./customer-lead";

export interface DealerSalesperson {
  id: string;
  /** = dealers.dealer_id / leads.dealer_id. */
  dealerCode: string;
  /** As stored — E.164 without '+'. */
  waPhone: string;
  displayName: string;
}

/**
 * Every storage variant an inbound wa_phone ("919876543210", no '+') might be
 * stored as. Same rule as operator-identity.phoneVariants, kept separate so the
 * lookups can diverge without surprising each other.
 */
function phoneVariants(waPhone: string): string[] {
  return [...new Set<string>([waPhone, ...phoneLookupVariants(waPhone)])];
}

/**
 * Resolve an inbound WhatsApp phone to an ACTIVE salesperson, or null.
 * Null → the caller falls through to the normal dealer/customer routing, so an
 * empty dealer_salespersons table leaves the pre-E-277 behaviour unchanged.
 */
export async function resolveSalesperson(
  waPhone: string,
): Promise<DealerSalesperson | null> {
  if (!waPhone) return null;

  try {
    const [row] = await db
      .select({
        id: dealerSalespersons.id,
        dealerCode: dealerSalespersons.dealer_code,
        waPhone: dealerSalespersons.wa_phone,
        displayName: dealerSalespersons.display_name,
      })
      .from(dealerSalespersons)
      .where(
        and(
          inArray(dealerSalespersons.wa_phone, phoneVariants(waPhone)),
          eq(dealerSalespersons.is_active, true),
        ),
      )
      .limit(1);

    return row ?? null;
  } catch (err) {
    // This runs on EVERY inbound message. If E-277 hasn't been applied yet the
    // table is missing, and throwing here would take down the whole WhatsApp
    // bot. Degrade to "no salespersons" instead — the pre-E-277 behaviour.
    console.error(
      "[WhatsApp/salesperson-identity] lookup failed (is E-277 applied?):",
      err,
    );
    return null;
  }
}

/**
 * Build the ActiveDealer identity a salesperson acts under. Fails closed
 * (null) when the dealership is missing or no longer active, or when its
 * canonical login user can't be resolved — salesperson access dies with the
 * dealership rather than creating orphan leads.
 */
export async function resolveDealerForSalesperson(
  sp: DealerSalesperson,
): Promise<ActiveDealer | null> {
  const [dealer] = await db
    .select({
      dealerCode: dealers.dealer_id,
      companyName: dealers.company_name,
      ownerName: dealers.owner_name,
    })
    .from(dealers)
    .where(
      and(
        eq(dealers.dealer_id, sp.dealerCode),
        eq(dealers.onboarding_status, "active"),
      ),
    )
    .limit(1);
  if (!dealer?.dealerCode) return null;

  // The dealer's canonical login user — leads.uploader_id is NOT NULL and the
  // salesperson has no users row of their own.
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.dealer_id, dealer.dealerCode), eq(users.role, "dealer")))
    .limit(1);
  if (!u?.id) return null;

  return {
    dealerCode: dealer.dealerCode,
    uploaderId: u.id,
    dealerName: dealer.ownerName || dealer.companyName || "there",
    financeEnabled: await resolveDealerFinanceEnabled(dealer.dealerCode),
    actor: {
      role: "salesperson",
      salespersonId: sp.id,
      displayName: sp.displayName,
    },
  };
}
