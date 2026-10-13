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
import { hasAccountClosuresTable } from "@/lib/accounts/tables";
import { capabilitiesFor } from "@/lib/dealer/dealer-capabilities";
import { resolveHouseDealer } from "@/lib/whatsapp/customer-lead";

import { pickerDealers, tenDigitMobile } from "./pushToDealer";

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

/**
 * ID 33: dealer codes (of those given) whose account was closed by hand
 * (E-332 "Lost / closed dealer"). A closed dealer is not an active push
 * target. Reads "nobody is closed" on a database without E-332.
 */
export async function closedDealerCodes(codes: string[]): Promise<Set<string>> {
  const ids = Array.from(new Set(codes.filter(Boolean)));
  if (!ids.length || !(await hasAccountClosuresTable())) return new Set();
  try {
    const rows = (await db.execute(sql`
      SELECT account_id FROM account_closures
       WHERE account_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    `)) as unknown as Array<{ account_id: string }>;
    return new Set(rows.map((r) => r.account_id));
  } catch (err) {
    console.error("[dealerByMobile] closed-dealer lookup failed:", err);
    return new Set();
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

  const closed = await closedDealerCodes(rows.map((r) => r.dealerId ?? ""));
  const active = rows.filter(
    (r) =>
      !!r.dealerId &&
      r.onboardingStatus === "active" &&
      capabilitiesFor(r.dealerType).newBattery &&
      !closed.has(r.dealerId),
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

// ── ID 33: CRM "Push to dealer" — pick a dealer by id or search by name ──────

const isPushable = (r: { dealerId: string | null; onboardingStatus: string | null; dealerType: string | null }) =>
  !!r.dealerId && r.onboardingStatus === "active" && capabilitiesFor(r.dealerType).newBattery;

const dealerPickColumns = {
  dealerId: dealers.dealer_id,
  companyName: dealers.company_name,
  accountName: accounts.business_entity_name,
  onboardingStatus: dealers.onboarding_status,
  financeEnabled: dealers.finance_enabled,
  dealerType: dealers.dealer_type,
};

/** ID 33: the active dealer behind a dealer code (picked from search), or null. */
export async function findActiveDealerById(
  dealerId: string | null | undefined,
): Promise<PushTargetDealer | null> {
  const code = (dealerId ?? "").trim();
  if (!code) return null;
  const house = await houseDealerCode();
  if (code === house) return null;
  const [r] = await db
    .select(dealerPickColumns)
    .from(dealers)
    .leftJoin(accounts, eq(accounts.id, dealers.dealer_id))
    .where(eq(dealers.dealer_id, code))
    .limit(1);
  if (!r || !isPushable(r)) return null;
  if ((await closedDealerCodes([r.dealerId!])).has(r.dealerId!)) return null;
  return { dealerId: r.dealerId!, name: r.accountName || r.companyName, financeEnabled: Boolean(r.financeEnabled) };
}

/**
 * ID 33: approved, active dealers whose name (legal entity, company or owner)
 * contains `query`; a 10-digit mobile is resolved through
 * findActiveDealerByMobile instead. Never the house dealer, never a closed
 * account. `financeOnly` (the customer needs a loan) keeps finance-enabled
 * dealers only. Returns id, name and finance flag only — no phone, email or
 * bank details.
 */
export async function searchActiveDealers(
  query: string,
  limit = 10,
  opts: { financeOnly?: boolean } = {},
): Promise<PushTargetDealer[]> {
  const q = (query ?? "").trim();
  if (q.length < 2) return [];

  const mobile = tenDigitMobile(q);
  if (mobile) {
    const r = await findActiveDealerByMobile(mobile);
    return pickerDealers(r.status === "found" ? [r.dealer] : [], opts);
  }

  const house = await houseDealerCode();
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const rows = await db
    .select(dealerPickColumns)
    .from(dealers)
    .leftJoin(accounts, eq(accounts.id, dealers.dealer_id))
    .where(
      and(
        eq(dealers.onboarding_status, "active"),
        sql`${dealers.dealer_id} IS NOT NULL`,
        house ? sql`${dealers.dealer_id} <> ${house}` : sql`true`,
        opts.financeOnly ? eq(dealers.finance_enabled, true) : sql`true`,
        sql`(${dealers.company_name} ILIKE ${like} OR ${accounts.business_entity_name} ILIKE ${like} OR ${dealers.owner_name} ILIKE ${like})`,
      ),
    )
    .orderBy(dealers.company_name)
    // over-fetch: the capability filter below runs in JS
    .limit(limit * 3);

  const closed = await closedDealerCodes(rows.map((r) => r.dealerId ?? ""));
  return pickerDealers(
    rows
      .filter((r) => isPushable(r) && !closed.has(r.dealerId!))
      .map((r) => ({ dealerId: r.dealerId!, name: r.accountName || r.companyName, financeEnabled: Boolean(r.financeEnabled) })),
    opts,
  ).slice(0, limit);
}
