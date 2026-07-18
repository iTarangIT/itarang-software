/**
 * Party account/contact reads for the online-money surface (E-193/R4–R5).
 *
 * The dealer's payout bank and the agreed vendor's contact live on the shared
 * `accounts` table. Three routes need them — the RazorpayX payout route, the
 * bank-details PATCH, and the Razorpay payment-link route — so the resolution
 * (and the masking rule that a full account number NEVER leaves the DB) lives in
 * one place rather than being re-derived per route.
 *
 * THE MASKING CONTRACT: `loadDealerBank` returns BOTH a `view` (safe to send to a
 * client or write to an activity row — the account is `••••1234`) and the raw
 * `account_number` (needed ONLY for the RazorpayX fund_account). A caller must
 * put the raw number into the provider call and NOTHING else — never a response,
 * a log, or an audit row. The `view` is the only shape that may be surfaced.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import type { BuybackTx } from "./tx";

type Runner = BuybackTx | typeof db;

/** RazorpayX / NPCI IFSC format: 4 letters, a 0, then 6 alphanumerics. */
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** True when `ifsc` is a well-formed IFSC (uppercased before the test). */
export function isValidIfsc(ifsc: string | null | undefined): boolean {
  return Boolean(ifsc) && IFSC_RE.test(String(ifsc).toUpperCase());
}

/** '••••1234' — last four only, never the whole number. Null → null. */
export function maskAccount(n: string | null | undefined): string | null {
  if (!n) return null;
  return `••••${n.slice(-4)}`;
}

/** The masked, surfaceable view of a dealer's payout bank — the same shape the
 *  invoice GET's gateway.dealer_bank block returns. */
export interface DealerBankView {
  ok: boolean;
  bank_name: string | null;
  account_masked: string | null;
  ifsc_code: string | null;
  beneficiary: string | null;
}

export interface DealerBank {
  /** Safe to surface (response / activity row). */
  view: DealerBankView;
  /** RAW — for the RazorpayX fund_account ONLY. Never surface or log. */
  account_number: string | null;
  ifsc_code: string | null;
  /** bank_beneficiary_name ?? business_entity_name. */
  beneficiary: string | null;
  business_entity_name: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
}

/** Load a dealer entity's payout bank, or null if the accounts row is missing. */
export async function loadDealerBank(
  entityId: string,
  runner: Runner = db,
): Promise<DealerBank | null> {
  const rows = await runner.execute(sql`
    SELECT bank_name, bank_account_number, ifsc_code, bank_beneficiary_name,
           business_entity_name, contact_name, contact_email, contact_phone
    FROM accounts
    WHERE id = ${entityId}
    LIMIT 1
  `);
  const a = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!a) return null;

  const account = (a.bank_account_number as string) ?? null;
  const ifsc = (a.ifsc_code as string) ?? null;
  const beneficiary =
    (a.bank_beneficiary_name as string) ?? (a.business_entity_name as string) ?? null;

  return {
    view: {
      ok: Boolean(account && ifsc),
      bank_name: (a.bank_name as string) ?? null,
      account_masked: maskAccount(account),
      ifsc_code: ifsc,
      beneficiary,
    },
    account_number: account,
    ifsc_code: ifsc,
    beneficiary,
    business_entity_name: a.business_entity_name as string,
    contact_name: (a.contact_name as string) ?? null,
    contact_email: (a.contact_email as string) ?? null,
    contact_phone: (a.contact_phone as string) ?? null,
  };
}

export interface VendorContact {
  entity_id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

/**
 * The AGREED vendor's contact for a deal — name/email/phone off their accounts
 * row (the same vendor_threads → scrap_vendors → accounts join the invoice route
 * uses for the vendor invoice). Null if no vendor has agreed on this deal.
 */
export async function loadAgreedVendorContact(
  dealId: string,
  runner: Runner = db,
): Promise<VendorContact | null> {
  const rows = await runner.execute(sql`
    SELECT a.id AS entity_id, a.business_entity_name AS name,
           a.contact_email AS email, a.contact_phone AS phone
    FROM vendor_threads vt
    JOIN scrap_vendors sv ON sv.id = vt.vendor_id
    JOIN accounts a       ON a.id = sv.entity_id
    WHERE vt.deal_id = ${dealId} AND vt.status = 'AGREED'
    LIMIT 1
  `);
  const v = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!v) return null;
  return {
    entity_id: String(v.entity_id),
    name: String(v.name),
    email: (v.email as string) ?? null,
    phone: (v.phone as string) ?? null,
  };
}
