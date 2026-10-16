// ID 33: database reads behind the "Push to dealer" rules. The rules
// themselves are pure (./pushToDealer checkPush); this file only gathers the
// facts they need — has the customer signed consent, was the file pushed
// before, what is the current dealer called — plus the push history shown on
// the CRM KYC file screen.

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { logCouponAction } from "@/lib/coupon-audit";
import { db } from "@/lib/db";
import {
  accounts,
  auditLogs,
  consentRecords,
  couponCodes,
  dealers,
  dealerSalespersons,
  leads,
  users,
} from "@/lib/db/schema";

import { anyConsentSigned, couponOnPush } from "./pushToDealer";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const LEAD_PUSHED_TO_DEALER = "LEAD_PUSHED_TO_DEALER";

/**
 * Lead ids (of those given) on which ANY consent — customer or co-borrower —
 * is signed. Reads both the lead's mirrored status columns and every
 * consent_records row, so a consent that only one of them has caught up with
 * still blocks the move.
 */
export async function signedConsentLeadIds(leadIds: string[]): Promise<Set<string>> {
  const ids = Array.from(new Set(leadIds.filter(Boolean)));
  if (!ids.length) return new Set();

  const [leadRows, recordRows] = await Promise.all([
    db
      .select({ id: leads.id, c: leads.consent_status, b: leads.borrower_consent_status })
      .from(leads)
      .where(inArray(leads.id, ids)),
    db
      .select({ id: consentRecords.lead_id, c: consentRecords.consent_status })
      .from(consentRecords)
      .where(inArray(consentRecords.lead_id, ids)),
  ]);

  const signed = new Set<string>();
  for (const r of leadRows) if (anyConsentSigned([r.c, r.b])) signed.add(r.id);
  for (const r of recordRows) if (anyConsentSigned([r.c])) signed.add(r.id);
  return signed;
}

/** Lead ids (of those given) that already carry a LEAD_PUSHED_TO_DEALER audit row. */
export async function pushedBeforeLeadIds(leadIds: string[]): Promise<Set<string>> {
  const ids = Array.from(new Set(leadIds.filter(Boolean)));
  if (!ids.length) return new Set();
  const rows = await db
    .select({ id: auditLogs.entity_id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entity_type, "lead"),
        eq(auditLogs.action, LEAD_PUSHED_TO_DEALER),
        inArray(auditLogs.entity_id, ids),
      ),
    );
  return new Set(rows.map((r) => r.id).filter((x): x is string => !!x));
}

/**
 * 14 Oct: lead ids (of those given — or, with none given, every such lead)
 * the house dealer pushed out at some point: a LEAD_PUSHED_TO_DEALER row whose
 * from_dealer_id is the house. 16 Oct (ID 183): the house logins keep working
 * these (never dispatch) and see them on Pushed files; they are no longer on
 * the house's own lead list, counts or cards, and the house never pushes them
 * again (a second move is Admin's).
 */
export async function houseOriginatedLeadIds(houseCode: string, leadIds?: string[]): Promise<Set<string>> {
  if (!houseCode) return new Set();
  const ids = leadIds ? Array.from(new Set(leadIds.filter(Boolean))) : null;
  if (ids && !ids.length) return new Set();
  const rows = await db
    .select({ id: auditLogs.entity_id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.entity_type, "lead"),
        eq(auditLogs.action, LEAD_PUSHED_TO_DEALER),
        sql`${auditLogs.changes} ->> 'from_dealer_id' = ${houseCode}`,
        ...(ids ? [inArray(auditLogs.entity_id, ids)] : []),
      ),
    );
  return new Set(rows.map((r) => r.id).filter((x): x is string => !!x));
}

/** Display name per dealer code (legal entity name, else company name, else the code). */
export async function dealerDisplayNames(codes: string[]): Promise<Map<string, string>> {
  const ids = Array.from(new Set(codes.filter(Boolean)));
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const [accRows, dealerRows] = await Promise.all([
    db.select({ id: accounts.id, name: accounts.business_entity_name }).from(accounts).where(inArray(accounts.id, ids)),
    db.select({ id: dealers.dealer_id, name: dealers.company_name }).from(dealers).where(inArray(dealers.dealer_id, ids)),
  ]);
  for (const r of dealerRows) if (r.id && r.name) out.set(r.id, r.name);
  for (const r of accRows) if (r.name) out.set(r.id, r.name);
  for (const id of ids) if (!out.has(id)) out.set(id, id);
  return out;
}

/**
 * 14 Oct: name + mobile per dealer code — the "With dealer" line the house
 * dealer sees on a file it pushed out. Mobile from the dealer record (owner
 * phone), else the dealer account's contact phone.
 */
export async function dealerContacts(codes: string[]): Promise<Map<string, { name: string; mobile: string | null }>> {
  const ids = Array.from(new Set(codes.filter(Boolean)));
  const out = new Map<string, { name: string; mobile: string | null }>();
  if (!ids.length) return out;
  const [names, dealerRows, accRows] = await Promise.all([
    dealerDisplayNames(ids),
    db.select({ id: dealers.dealer_id, phone: dealers.owner_phone, trade: dealers.company_name }).from(dealers).where(inArray(dealers.dealer_id, ids)),
    db.select({ id: accounts.id, phone: accounts.contact_phone }).from(accounts).where(inArray(accounts.id, ids)),
  ]);
  const phone = new Map<string, string>();
  for (const r of accRows) if (r.phone) phone.set(r.id, r.phone);
  for (const r of dealerRows) if (r.id && r.phone) phone.set(r.id, r.phone);
  // The account's legal name leads (what the push lookup shows); the dealer
  // record's trade name follows in brackets when the two disagree, so the
  // house recognises the dealer by either.
  const trade = new Map(dealerRows.filter((r) => r.id && r.trade).map((r) => [r.id as string, String(r.trade).trim()]));
  for (const id of ids) {
    const legal = names.get(id) ?? id;
    const t = trade.get(id);
    const name = t && t.toLowerCase() !== legal.trim().toLowerCase() ? `${legal} (${t})` : legal;
    out.set(id, { name, mobile: phone.get(id) ?? null });
  }
  return out;
}

export interface PushHistoryRow {
  at: string;
  fromDealerId: string | null;
  fromDealerName: string | null;
  toDealerId: string | null;
  toDealerName: string | null;
  byUserId: string | null;
  byName: string | null;
  /** ID 182: the pusher's role at the time (admin, sales_head, dealer = a house login …). */
  byRole: string | null;
  reason: string | null;
  via: string | null;
  /** Coupon code given back to the old dealer's pool on this push, if any. */
  couponReleased: string | null;
  /** Name (or id) of the old dealer's salesperson taken off the file, if any. */
  salespersonCleared: string | null;
}

/** ID 33: every push of a file, oldest first — who, when, from, to, why. */
export async function pushHistory(leadId: string): Promise<PushHistoryRow[]> {
  const rows = await db
    .select({
      at: auditLogs.timestamp,
      changes: auditLogs.changes,
      by: auditLogs.performed_by,
      byName: users.name,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.performed_by))
    .where(
      and(
        eq(auditLogs.entity_type, "lead"),
        eq(auditLogs.entity_id, leadId),
        eq(auditLogs.action, LEAD_PUSHED_TO_DEALER),
      ),
    )
    .orderBy(asc(auditLogs.timestamp));

  const parsed = rows.map((r) => ({ r, c: (r.changes ?? {}) as Record<string, unknown> }));
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const names = await dealerDisplayNames(
    parsed.flatMap(({ c }) => [str(c.from_dealer_id), str(c.to_dealer_id)]).filter((x): x is string => !!x),
  );

  return parsed.map(({ r, c }) => {
    const from = str(c.from_dealer_id);
    const to = str(c.to_dealer_id);
    return {
      at: (r.at instanceof Date ? r.at : new Date(r.at)).toISOString(),
      fromDealerId: from,
      fromDealerName: str(c.from_dealer_name) ?? (from ? names.get(from) ?? from : null),
      toDealerId: to,
      toDealerName: str(c.to_dealer_name) ?? (to ? names.get(to) ?? to : null),
      byUserId: r.by,
      byName: r.byName ?? str(c.by_name),
      byRole: str(c.by_role),
      reason: str(c.reason),
      via: str(c.via),
      couponReleased: str(c.coupon_released),
      salespersonCleared: str(c.salesperson_cleared_name) ?? str(c.salesperson_cleared),
    };
  });
}

// ── ID 33: what leaves with the old dealer ──────────────────────────────────

export interface DetachResult {
  /** Coupon code taken off the file and (when it was a pool coupon) put back as available. */
  couponReleased: string | null;
  /** coupon_codes.id of the released coupon, for the coupon audit trail (null for ITARANG-FREE). */
  couponReleasedId: string | null;
  /** A USED coupon (fee already paid) stays on the file as a record. */
  couponKeptUsed: string | null;
  salespersonCleared: string | null;
  salespersonClearedName: string | null;
}

/**
 * ID 33: inside the push transaction — give the old dealer's reserved coupon
 * back to their pool (same writes as /api/kyc/[leadId]/release-coupon) and take
 * the old dealer's salesperson off the file. Returns what it did, for the push
 * audit row. Call logPushCouponRelease after the transaction commits.
 */
export async function detachFromOldDealer(tx: Tx, leadId: string): Promise<DetachResult> {
  const out: DetachResult = {
    couponReleased: null,
    couponReleasedId: null,
    couponKeptUsed: null,
    salespersonCleared: null,
    salespersonClearedName: null,
  };
  const [lead] = await tx
    .select({
      couponCode: leads.coupon_code,
      couponStatus: leads.coupon_status,
      salespersonId: leads.salesperson_id,
      salespersonName: dealerSalespersons.display_name,
    })
    .from(leads)
    .leftJoin(dealerSalespersons, eq(dealerSalespersons.id, leads.salesperson_id))
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return out;

  const set: Partial<typeof leads.$inferInsert> = {};
  const coupon = couponOnPush(lead.couponCode, lead.couponStatus);
  if (coupon === "release" && lead.couponCode) {
    const released = await tx
      .update(couponCodes)
      .set({ status: "available", reserved_at: null, reserved_by: null, reserved_for_lead_id: null })
      .where(
        and(
          eq(couponCodes.code, lead.couponCode),
          eq(couponCodes.status, "reserved"),
          eq(couponCodes.reserved_for_lead_id, leadId),
        ),
      )
      .returning({ id: couponCodes.id });
    out.couponReleased = lead.couponCode;
    out.couponReleasedId = released[0]?.id ?? null;
    set.coupon_code = null;
    set.coupon_status = null;
  } else if (coupon === "keep_used") {
    out.couponKeptUsed = lead.couponCode;
  }

  if (lead.salespersonId) {
    out.salespersonCleared = lead.salespersonId;
    out.salespersonClearedName = lead.salespersonName ?? null;
    set.salesperson_id = null;
  }

  if (Object.keys(set).length) {
    await tx.update(leads).set(set).where(eq(leads.id, leadId));
  }
  return out;
}

/** The detach result as push-audit `changes` keys (only the ones that happened). */
export function detachAuditChanges(d: DetachResult): Record<string, string> {
  const c: Record<string, string> = {};
  if (d.couponReleased) c.coupon_released = d.couponReleased;
  if (d.couponKeptUsed) c.coupon_kept_used = d.couponKeptUsed;
  if (d.salespersonCleared) c.salesperson_cleared = d.salespersonCleared;
  if (d.salespersonClearedName) c.salesperson_cleared_name = d.salespersonClearedName;
  return c;
}

/** After commit: the coupon audit row for a released pool coupon. Never throws. */
export async function logPushCouponRelease(
  d: DetachResult,
  leadId: string,
  userId: string | null,
  toDealerName: string,
): Promise<void> {
  if (!d.couponReleasedId) return;
  await logCouponAction({
    couponId: d.couponReleasedId,
    action: "released",
    oldStatus: "reserved",
    newStatus: "available",
    leadId,
    performedBy: userId,
    notes: `File pushed to ${toDealerName} (ID 33) - coupon returned to the previous dealer`,
  });
}
