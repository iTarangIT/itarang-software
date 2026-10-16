import { NextResponse } from "next/server";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { accountOwnership, dealerOnboardingApplications, leads } from "@/lib/db/schema";
import { getAuthenticatedAppUser } from "@/lib/kyc/admin-workflow";
import {
  ALL_LEADS_KYC_ROLES,
  backOfficeOwnsLead,
  dealerOwnsLead,
  mayReadFullIds,
  FULL_ID_ROLES,
  OWN_LEADS_KYC_ROLES,
} from "@/lib/auth/leadAccessRules";
import { houseDealerCode } from "@/lib/leads/dealerByMobile";
import { houseOriginatedLeadIds } from "@/lib/leads/pushGuards";

// ID 119 (decided 16 Oct): only Admin, the CEO and the Sales Head reach every
// customer file's KYC. Sales Manager, Sales Executive, Business Head and
// Finance Controller reach only the files they own (uploader, assigned_to,
// sm_assigned_to, or owner of the dealer's account) — backOfficeOwnsLead.
// Mirrored by requireAdminAppUserForLead in src/lib/kyc/admin-workflow.ts.
//
// ID 119 / ID 166 (10 Oct): reaching the lead is not the same as reading the
// customer's full PAN. That is only for Admin, the Sales Head, the CEO and the
// lead's owner — see `fullIds` on the result and mayReadFullIds().
const ALL_LEADS_ROLES = new Set<string>(ALL_LEADS_KYC_ROLES);
const OWN_LEADS_ROLES = new Set<string>(OWN_LEADS_KYC_ROLES);

/**
 * ID 119: may this OWN-LEADS back-office user (sales manager, sales
 * executive, business head, finance controller) reach lead `leadId`?
 */
export async function backOfficeReachesLead(userId: string, leadId: string): Promise<boolean> {
  try {
    const [lead] = await db
      .select({
        dealer_id: leads.dealer_id,
        uploader_id: leads.uploader_id,
        assigned_to: leads.assigned_to,
        sm_assigned_to: leads.sm_assigned_to,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) return false;
    let accountOwnerId: string | null = null;
    if (lead.dealer_id) {
      const [own] = await db
        .select({ owner: accountOwnership.owner_user_id })
        .from(accountOwnership)
        .where(eq(accountOwnership.account_id, lead.dealer_id))
        .limit(1);
      accountOwnerId = own?.owner ?? null;
    }
    return backOfficeOwnsLead({
      userId,
      uploaderId: lead.uploader_id,
      assignedTo: lead.assigned_to,
      smAssignedTo: lead.sm_assigned_to,
      accountOwnerId,
    });
  } catch (err) {
    console.error("[backOfficeReachesLead] lookup failed:", err);
    return false;
  }
}

/** ID 119: may this back-office role reach this lead's KYC at all? */
export async function backOfficeMayReachLead(user: { id: string; role: string | null }, leadId: string): Promise<boolean> {
  const role = (user.role ?? "").toLowerCase();
  if (ALL_LEADS_ROLES.has(role)) return true;
  if (OWN_LEADS_ROLES.has(role)) return backOfficeReachesLead(user.id, leadId);
  return false;
}

export type LeadAccessResult =
  | {
      ok: true;
      user: {
        id: string;
        role: string;
        dealer_id: string | null;
        /** May this caller see the customer's full PAN? Else mask it (maskPan). */
        fullIds: boolean;
      };
    }
  | { ok: false; response: NextResponse };

/**
 * Gate an ID-scoped lead route. Middleware treats /api/* as public
 * (src/middleware.ts), so every lead-scoped handler must call this itself.
 * Enforces two things:
 *   1. an authenticated session (else 401), and
 *   2. that the caller owns this lead — a dealer may only touch leads whose
 *      leads.dealer_id equals their users.dealer_id (dealer CODE) — or, for a
 *      dealer login with no users.dealer_id, the dealer_code on their approved
 *      onboarding application (ID 119); back-office roles pass through.
 * This closes the IDOR the security scanner flagged on
 * /api/coborrower/[leadId] (anonymous read of a co-borrower record by id).
 * The 403 is intentionally identical for "lead not found" and "not yours" so
 * the endpoint can't be used to probe which ids exist.
 */
export async function requireLeadAccess(leadId: string): Promise<LeadAccessResult> {
  const user = await getAuthenticatedAppUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: { message: "Unauthorized" } },
        { status: 401 }
      ),
    };
  }

  if (ALL_LEADS_ROLES.has(user.role) || OWN_LEADS_ROLES.has(user.role)) {
    // ID 119: own-leads roles are refused on someone else's file (same 403).
    if (!ALL_LEADS_ROLES.has(user.role) && !(await backOfficeReachesLead(user.id, leadId))) {
      return {
        ok: false,
        response: NextResponse.json(
          { success: false, error: { message: "Forbidden" } },
          { status: 403 }
        ),
      };
    }
    return {
      ok: true,
      user: {
        id: user.id,
        role: user.role,
        dealer_id: user.dealer_id,
        fullIds: await fullIdsForLead(user, leadId),
      },
    };
  }

  // Dealer (or any other non-back-office role): must own the lead.
  const [lead] = await db
    .select({ dealer_id: leads.dealer_id, uploader_id: leads.uploader_id })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);

  // ID 119: a dealer login whose users.dealer_id was never filled in was
  // refused on its OWN leads. Fall back to the dealer code on its onboarding
  // application — the same `users.dealer_id || application.dealer_code`
  // resolution /api/dealer/stats and /api/user/profile/details use — but only
  // for the dealer role, and only via dealer_user_id (never the email match,
  // which can pick up someone else's draft).
  const dealerCode =
    user.dealer_id ||
    (user.role === "dealer" && lead ? await dealerCodeFromApplication(user.id) : null);

  // ID 33: a lead the iTarang House login pushed to another dealer keeps
  // uploader_id = the person who created it, so they can still finish its KYC.
  const isUploader = !!lead && lead.uploader_id === user.id;
  // 14 Oct: the house login keeps access to every file it pushed out, wherever
  // the file is now (houseMayActOnLead). 16 Oct (ID 183): to SEE it only —
  // every write route also runs requireLeadWriter / gateLeadActor, which
  // refuses the house on a file that is with another dealer.
  const houseFile =
    !!lead && !isUploader && !dealerOwnsLead(lead.dealer_id, dealerCode) && (await houseMayActOnLead(dealerCode, leadId));

  if (!lead || (!isUploader && !houseFile && !dealerOwnsLead(lead.dealer_id, dealerCode))) {
    return {
      ok: false,
      response: NextResponse.json(
        { success: false, error: { message: "Forbidden" } },
        { status: 403 }
      ),
    };
  }

  // Past the gate, a dealer (or uploader) is the lead's owner: full PAN.
  return { ok: true, user: { id: user.id, role: user.role, dealer_id: dealerCode, fullIds: true } };
}

/**
 * May this signed-in user read lead `leadId`'s full PAN (ID 119 / ID 166)?
 * For routes that gate the lead some other way (the admin case review uses
 * requireAdminAppUser). Admin, Sales Head and CEO never touch the database.
 */
export async function fullIdsForLead(
  user: { id: string; role: string | null; dealer_id?: string | null },
  leadId: string,
): Promise<boolean> {
  const role = (user.role ?? "").toLowerCase();
  if ((FULL_ID_ROLES as readonly string[]).includes(role)) return true;
  try {
    const [lead] = await db
      .select({ dealer_id: leads.dealer_id, uploader_id: leads.uploader_id })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) return false;
    let accountOwnerId: string | null = null;
    if (lead.dealer_id) {
      // leads.dealer_id is the dealer's account id (users.dealer_id = accounts.id).
      const [own] = await db
        .select({ owner: accountOwnership.owner_user_id })
        .from(accountOwnership)
        .where(eq(accountOwnership.account_id, lead.dealer_id))
        .limit(1);
      accountOwnerId = own?.owner ?? null;
    }
    const dealerCode = role === "dealer" ? await resolveDealerCode({ id: user.id, role, dealer_id: user.dealer_id ?? null }) : null;
    return mayReadFullIds({
      role,
      userId: user.id,
      leadUploaderId: lead.uploader_id,
      accountOwnerId,
      dealerOwnsLead: role === "dealer" && dealerOwnsLead(lead.dealer_id, dealerCode),
    });
  } catch (err) {
    console.error("[fullIdsForLead] owner lookup failed:", err);
    return false;
  }
}

/**
 * The dealer code a dealer login acts under: users.dealer_id, or — for a
 * dealer login whose users.dealer_id was never filled in — the code on its
 * approved onboarding application (ID 119). Null for any other role without
 * a dealer_id.
 */
export async function resolveDealerCode(user: {
  id: string;
  role: string | null;
  dealer_id: string | null;
}): Promise<string | null> {
  const own = user.dealer_id?.trim();
  if (own) return own;
  if ((user.role ?? "").toLowerCase() !== "dealer") return null;
  return dealerCodeFromApplication(user.id);
}

/**
 * May this dealer act on (change) a lead whose leads.dealer_id is
 * `leadDealerId`? Replaces the raw `lead.dealer_id !== user.dealer_id` compare
 * in the dealer lead routes, which refused a dealer login with no
 * users.dealer_id on its own leads (ID 119) — and let two empty values count
 * as the same dealer.
 *
 * 16 Oct (ID 183): the file's own dealer only. The house login no longer acts
 * on a file it pushed to another dealer (the dealer is the only owner); it
 * still SEES it — dealerMayViewLead.
 */
export async function dealerMayActOnLead(
  user: { id: string; role: string | null; dealer_id: string | null },
  leadDealerId: string | null | undefined,
  /** The lead's id. Kept for the callers; until 16 Oct it let the house act. */
  leadId?: string | null,
): Promise<boolean> {
  void leadId;
  return dealerOwnsLead(leadDealerId, await resolveDealerCode(user));
}

/**
 * May this dealer login SEE a lead: its own dealer's file, or — for a house
 * login — a file the house pushed out (Pushed files opens it read-only).
 */
export async function dealerMayViewLead(
  user: { id: string; role: string | null; dealer_id: string | null },
  leadDealerId: string | null | undefined,
  leadId: string,
): Promise<boolean> {
  const code = await resolveDealerCode(user);
  if (dealerOwnsLead(leadDealerId, code)) return true;
  return houseMayActOnLead(code, leadId);
}

/**
 * ID 183 (16 Oct): the steps iTarang never takes — Step 5 (the dealer's stock,
 * the customer's dispatch OTP, dispatch), the cash sale and "delivered". Only
 * the dealer the file belongs to; the house login loses them too.
 */
export async function dealerMayDispatch(
  user: { id: string; role: string | null; dealer_id: string | null },
  leadDealerId: string | null | undefined,
): Promise<boolean> {
  return dealerOwnsLead(leadDealerId, await resolveDealerCode(user));
}

/**
 * 14 Oct: the iTarang house dealer keeps access to a customer file after
 * pushing it to a dealer so it can see and continue what the dealer does.
 * 16 Oct (ID 33 / 183): SEE only — no step on it at all (gateLeadActor /
 * leadActorVerdict refuse the house's writes), no second push
 * (pushBlockedReason), and the file leaves the house's own lists and counts —
 * the dealer is its only owner; the house sees it on Pushed files. The name
 * is kept for its callers. True when the caller's dealer code IS the house code (any house
 * login) and the file carries a push FROM the house (houseOriginatedLeadIds).
 */
export async function houseMayActOnLead(callerDealerCode: string | null | undefined, leadId: string): Promise<boolean> {
  const code = (callerDealerCode ?? "").trim();
  if (!code || !leadId) return false;
  const house = await houseDealerCode();
  if (!house || code !== house) return false;
  return (await houseOriginatedLeadIds(house, [leadId])).has(leadId);
}

/** Dealer code on the latest onboarding application this user owns, or null. */
async function dealerCodeFromApplication(userId: string): Promise<string | null> {
  try {
    const [app] = await db
      .select({ dealer_code: dealerOnboardingApplications.dealer_code })
      .from(dealerOnboardingApplications)
      .where(
        and(
          eq(dealerOnboardingApplications.dealer_user_id, userId),
          isNotNull(dealerOnboardingApplications.dealer_code),
        ),
      )
      .orderBy(desc(dealerOnboardingApplications.updated_at))
      .limit(1);
    return app?.dealer_code?.trim() || null;
  } catch (err) {
    console.error("[requireLeadAccess] dealer code fallback failed:", err);
    return null;
  }
}
