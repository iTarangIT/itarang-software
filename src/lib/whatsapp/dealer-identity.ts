// E-170 — map an inbound WhatsApp number to an APPROVED / active dealer.
//
// This is the fork point of the WhatsApp bot: if the sender is an approved
// dealer, they get the dealer self-service flow (lead creation, KYC, inventory,
// financing). Otherwise the message falls through to the existing onboarding
// flow (orchestrator.ts). Eligibility = ANY approved/active dealer, whether they
// onboarded via WhatsApp (matched on dealer_onboarding_applications.wa_phone) or
// the web (matched on dealers.owner_phone).

import { and, desc, eq, inArray, ne, or } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealers,
  leads,
  users,
} from "@/lib/db/schema";
import { phoneLookupVariants } from "@/lib/ai/phone";

export interface WhatsAppDealer {
  /** dealers.dealer_id — used as leads.dealer_id (satisfies the E-105 gate). */
  dealerCode: string;
  /** users.id (role=dealer) — used as leads.uploader_id. May be null if the
   *  canonical user row can't be resolved (rare; dealer can still be served). */
  dealerUserId: string | null;
  financeEnabled: boolean;
  /** Display name for greetings (owner/company name), when available. */
  dealerName: string | null;
  /** "whatsapp" if matched via the onboarding application's wa_phone, else "web". */
  matchedVia: "whatsapp" | "web";
}

/**
 * Every storage variant an inbound wa_phone ("919876543210", no '+') might be
 * stored as across dealers.owner_phone / applications.wa_phone:
 *   - the raw inbound form ("919876543210")
 *   - E.164 ("+919876543210") and 10-digit ("9876543210") via phoneLookupVariants
 */
function phoneVariants(waPhone: string): string[] {
  const set = new Set<string>([waPhone, ...phoneLookupVariants(waPhone)]);
  return [...set];
}

/**
 * Resolve an inbound WhatsApp phone to an approved/active dealer, or null.
 * Null → the caller falls through to the onboarding flow.
 */
export async function resolveWhatsAppDealer(
  waPhone: string,
): Promise<WhatsAppDealer | null> {
  if (!waPhone) return null;
  const variants = phoneVariants(waPhone);

  // 1) WhatsApp-onboarded: an approved application whose wa_phone matches.
  const [app] = await db
    .select({
      dealerCode: dealerOnboardingApplications.dealer_code,
      dealerUserId: dealerOnboardingApplications.dealer_user_id,
      financeEnabled: dealerOnboardingApplications.finance_enabled,
      ownerName: dealerOnboardingApplications.owner_name,
      companyName: dealerOnboardingApplications.company_name,
    })
    .from(dealerOnboardingApplications)
    .where(
      and(
        inArray(dealerOnboardingApplications.wa_phone, variants),
        eq(dealerOnboardingApplications.onboarding_status, "approved"),
      ),
    )
    .limit(1);

  if (app?.dealerCode) {
    // finance_enabled is read from the canonical `dealers` row, NOT from the
    // application. The two diverge during post-approval finance enablement:
    // the application flag flips as soon as an admin clicks Enable Finance,
    // while financing must stay off until the dealer agreement is signed and
    // Activate Finance runs. `dealers.finance_enabled` is what the E-105 gate
    // in /api/leads/create enforces, so this must match it or the console would
    // offer a finance path the API then rejects.
    const [dealerRow] = await db
      .select({ financeEnabled: dealers.finance_enabled })
      .from(dealers)
      .where(eq(dealers.dealer_id, app.dealerCode))
      .limit(1);

    return {
      dealerCode: app.dealerCode,
      dealerUserId: app.dealerUserId ?? null,
      financeEnabled: Boolean(dealerRow?.financeEnabled),
      dealerName: app.ownerName || app.companyName || null,
      matchedVia: "whatsapp",
    };
  }

  // 2) Any active dealer matched on owner_phone (covers web-onboarded dealers).
  const [dealer] = await db
    .select({
      dealerCode: dealers.dealer_id,
      financeEnabled: dealers.finance_enabled,
      companyName: dealers.company_name,
    })
    .from(dealers)
    .where(
      and(
        inArray(dealers.owner_phone, variants),
        eq(dealers.onboarding_status, "active"),
      ),
    )
    .limit(1);

  if (!dealer?.dealerCode) return null;

  // Resolve the canonical dealer login user (leads.uploader_id).
  const [u] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.dealer_id, dealer.dealerCode), eq(users.role, "dealer")))
    .limit(1);

  return {
    dealerCode: dealer.dealerCode,
    dealerUserId: u?.id ?? null,
    financeEnabled: Boolean(dealer.financeEnabled),
    dealerName: dealer.companyName || null,
    matchedVia: "web",
  };
}

// ── Known-contact recognition (greeting-time, non-dealer) ───────────────────

/** A sender recognized by phone as internal staff or an existing lead — greeted
 *  with a role/status-specific message instead of the generic entry menu. */
export type KnownContact =
  | { kind: "staff"; name: string; role: string }
  | {
      kind: "lead";
      name: string | null;
      status: string | null;
      referenceId: string | null;
    };

/**
 * Resolve an inbound WhatsApp phone to a known non-dealer contact, or null.
 * Checked only at greeting time (approved dealers are resolved separately and
 * take priority): (1) an active internal user (any role except dealer) matched
 * on users.phone; (2) the newest lead whose mobile/phone/owner_contact matches
 * (WhatsApp-created leads store "+91…" in all three).
 */
export async function resolveKnownContact(
  waPhone: string,
): Promise<KnownContact | null> {
  if (!waPhone) return null;
  const variants = phoneVariants(waPhone);

  const [staff] = await db
    .select({ name: users.name, role: users.role })
    .from(users)
    .where(
      and(
        inArray(users.phone, variants),
        eq(users.is_active, true),
        ne(users.role, "dealer"),
      ),
    )
    .limit(1);
  if (staff) return { kind: "staff", name: staff.name, role: staff.role };

  const [lead] = await db
    .select({
      name: leads.owner_name,
      status: leads.lead_status,
      referenceId: leads.reference_id,
    })
    .from(leads)
    .where(
      or(
        inArray(leads.mobile, variants),
        inArray(leads.phone, variants),
        inArray(leads.owner_contact, variants),
      ),
    )
    .orderBy(desc(leads.created_at))
    .limit(1);
  if (lead) {
    return {
      kind: "lead",
      name: lead.name,
      status: lead.status,
      referenceId: lead.referenceId,
    };
  }

  return null;
}
