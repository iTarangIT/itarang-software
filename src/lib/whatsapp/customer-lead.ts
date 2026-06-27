// Customer-lead data layer for the post-approval WhatsApp "dealer console".
//
// Once a dealer is admin-approved, the same WhatsApp number switches from the
// onboarding state machine (orchestrator.ts) to a console where the dealer can
// create customer leads. The orchestrator owns all messaging; this module owns
// the data: resolving the dealer behind a wa_phone and writing the lead.
//
// Auth note: there is NO Supabase session on a WhatsApp turn. The web lead route
// (POST /api/dealer/leads) authenticates the dealer via the browser session and
// uses users.dealer_id as leads.dealer_id. We can't do that here, so we resolve
// the same identity directly off the approved onboarding application — after
// approval it carries dealer_code (= accounts.id = leads.dealer_id FK target)
// and dealer_user_id (= the Supabase auth uuid = leads.uploader_id). See the
// approve route (admin/dealer-verifications/[dealerId]/approve) for the wiring.

import { and, desc, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";

import { generateId } from "@/lib/api-utils";
import { db } from "@/lib/db/index";
import {
  adminVerificationQueue,
  dealerOnboardingApplications,
  inventory,
  leads,
  paraphernaliaStock,
  personalDetails,
  products,
} from "@/lib/db/schema";

type Application = typeof dealerOnboardingApplications.$inferSelect;

/** The minimum identity needed to create a lead as an approved dealer. */
export interface ActiveDealer {
  /** dealer_code — the leads.dealer_id FK target (accounts.id for non-branch). */
  dealerCode: string;
  /** Supabase auth uuid — written as leads.uploader_id (NOT NULL). */
  uploaderId: string;
  /** Display name for greetings ("Hi Acme Motors"). */
  dealerName: string;
}

/**
 * Resolve an active (admin-approved) dealer from the onboarding application
 * linked to a WhatsApp session. Returns null when the application is not yet
 * approved or is missing the post-approval identity columns — in which case the
 * caller keeps the dealer in the onboarding flow.
 */
export function resolveActiveDealer(
  application: Application | null | undefined,
): ActiveDealer | null {
  if (!application) return null;
  const approved =
    application.onboarding_status === "approved" &&
    application.dealer_account_status === "active";
  if (!approved) return null;
  if (!application.dealer_code || !application.dealer_user_id) return null;
  return {
    dealerCode: application.dealer_code,
    uploaderId: application.dealer_user_id,
    dealerName:
      application.owner_name || application.company_name || "there",
  };
}

export type InterestLevel = "hot" | "warm" | "cold";
/** Canonical leads.payment_method values (must match the web Step-1 form). */
export type PaymentMethod = "finance" | "cash" | "other_finance";

/** Payment methods that (with a Hot lead) unlock the KYC consent flow. */
const FINANCE_METHODS: PaymentMethod[] = ["finance", "other_finance"];

/** True when this interest + payment combo requires the customer KYC consent. */
export function requiresConsent(
  interest: InterestLevel,
  paymentMethod: PaymentMethod,
): boolean {
  return interest === "hot" && FINANCE_METHODS.includes(paymentMethod);
}

export interface CreateCustomerLeadParams {
  dealer: ActiveDealer;
  /** Customer mobile, digits only (10) or +91 form — normalized to +91xxxx. */
  mobile: string;
  /** Customer name, if already known. Usually omitted on the WhatsApp console —
   *  the dealer is not asked to type it; it's extracted from the PAN / Aadhaar
   *  later and overwrites the placeholder stored here. */
  customerName?: string;
  interest: InterestLevel;
  paymentMethod: PaymentMethod;
}

/** Placeholder owner_name until the real name is read from the PAN / Aadhaar. */
const PENDING_CUSTOMER_NAME = "Customer";

/** Normalize a 10-digit / +91 mobile to the leads owner_contact "+91xxxxxxxxxx". */
export function normalizeMobile(raw: string): string | null {
  let digits = (raw ?? "").replace(/\D/g, "");
  // Accept the +91 / 91 country-code form by dropping the leading 91, but
  // otherwise require exactly 10 digits — reject anything longer or shorter
  // instead of silently keeping the last 10.
  if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  }
  if (digits.length !== 10) return null;
  return `+91${digits}`;
}

/**
 * Insert a customer lead (+ a stub personal_details row to receive extracted
 * KYC fields later). Mirrors the columns the web POST /api/dealer/leads sets so
 * the lead surfaces identically on the dealer/admin dashboards. Returns the new
 * lead id.
 */
export async function createCustomerLead(
  params: CreateCustomerLeadParams,
): Promise<string> {
  const { dealer, mobile, customerName, interest, paymentMethod } = params;
  const name = (customerName ?? "").trim() || PENDING_CUSTOMER_NAME;
  const leadId = await generateId("LEAD", leads);

  await db.transaction(async (tx) => {
    await tx.insert(leads).values({
      id: leadId,
      dealer_id: dealer.dealerCode,
      owner_name: name,
      owner_contact: mobile,
      mobile,
      // The web Step-1 form reads the customer number off leads.phone; mirror it
      // here (web PATCH keeps phone/owner_contact/mobile in lockstep) so the
      // WhatsApp lead's Phone field isn't blank when opened for editing.
      phone: mobile,
      lead_type: interest,
      lead_source: "dealer_referral",
      interest_level: interest,
      payment_method: paymentMethod,
      lead_status: "new",
      status: "ACTIVE",
      // Marks the lead as WhatsApp-originated (E-174). Web-dealer leads share
      // lead_source='dealer_referral', so this is the reliable discriminator the
      // admin KYC review uses to unlock documents without a coupon.
      source_channel: "whatsapp",
      uploader_id: dealer.uploaderId,
      state: "Unknown",
      city: "Unknown",
    });

    await tx.insert(personalDetails).values({
      id: crypto.randomUUID(),
      lead_id: leadId,
    });
  });

  return leadId;
}

// ── Dealer console: drafts ───────────────────────────────────────────────────

/** A WhatsApp-created customer lead that hasn't yet been submitted to iTarang
 *  for KYC review (no admin verification-queue entry). */
export interface DealerDraft {
  leadId: string;
  customerName: string;
  mobile: string;
  interest: InterestLevel | null;
  paymentMethod: PaymentMethod | null;
  updatedAt: Date | null;
}

/**
 * List this dealer's open WhatsApp drafts — leads created over WhatsApp that
 * have NOT yet been pushed to the admin KYC queue (the WhatsApp "submitted"
 * marker, see ensureAdminKycQueueEntry). Newest first, capped to `limit`
 * (WhatsApp interactive lists allow ≤10 rows).
 */
export async function listDealerDrafts(
  dealerCode: string,
  limit = 10,
): Promise<DealerDraft[]> {
  // Lead ids already submitted for KYC review — excluded from the draft list.
  const submitted = await db
    .selectDistinct({ leadId: adminVerificationQueue.lead_id })
    .from(adminVerificationQueue)
    .where(isNotNull(adminVerificationQueue.lead_id));
  const submittedIds = submitted
    .map((r) => r.leadId)
    .filter((id): id is string => !!id);

  const conds = [
    eq(leads.dealer_id, dealerCode),
    eq(leads.source_channel, "whatsapp"),
  ];
  if (submittedIds.length) {
    // notInArray → `leads.id not in ($1, …)`. (A hand-rolled `sql\`... <> all()\``
    // splats the JS array into a tuple `all(($1,$2,…))`, which Postgres rejects
    // because ALL requires an array, not a parenthesized list.)
    conds.push(notInArray(leads.id, submittedIds));
  }

  const rows = await db
    .select({
      id: leads.id,
      ownerName: leads.owner_name,
      fullName: leads.full_name,
      ownerContact: leads.owner_contact,
      mobile: leads.mobile,
      interest: leads.interest_level,
      paymentMethod: leads.payment_method,
      updatedAt: leads.updated_at,
    })
    .from(leads)
    .where(and(...conds))
    .orderBy(desc(leads.updated_at))
    .limit(limit);

  return rows.map((r) => {
    const name =
      r.ownerName && r.ownerName !== PENDING_CUSTOMER_NAME
        ? r.ownerName
        : r.fullName || "Customer";
    return {
      leadId: r.id,
      customerName: name,
      mobile: r.mobile || r.ownerContact || "—",
      interest: (r.interest as InterestLevel | null) ?? null,
      paymentMethod: (r.paymentMethod as PaymentMethod | null) ?? null,
      updatedAt: r.updatedAt ?? null,
    };
  });
}

/** Load one draft by id, scoped to the dealer so a dealer can only resume their
 *  own leads. Returns null if not found / not theirs / already submitted. */
export async function getDealerDraft(
  dealerCode: string,
  leadId: string,
): Promise<DealerDraft | null> {
  const [row] = await db
    .select({
      id: leads.id,
      ownerName: leads.owner_name,
      fullName: leads.full_name,
      ownerContact: leads.owner_contact,
      mobile: leads.mobile,
      interest: leads.interest_level,
      paymentMethod: leads.payment_method,
      updatedAt: leads.updated_at,
    })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.dealer_id, dealerCode)))
    .limit(1);
  if (!row) return null;
  const name =
    row.ownerName && row.ownerName !== PENDING_CUSTOMER_NAME
      ? row.ownerName
      : row.fullName || "Customer";
  return {
    leadId: row.id,
    customerName: name,
    mobile: row.mobile || row.ownerContact || "—",
    interest: (row.interest as InterestLevel | null) ?? null,
    paymentMethod: (row.paymentMethod as PaymentMethod | null) ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

// ── Dealer console: inventory ────────────────────────────────────────────────

export interface DealerStockRow {
  label: string;
  category: string;
  available: number;
}

export interface DealerStockSummary {
  rows: DealerStockRow[];
  totalAvailable: number;
}

// Serialized inventory statuses that count as on-hand available stock. Mirrors
// getInventorySummary()/the dealer inventory route so the numbers agree.
const AVAILABLE_STATUSES = ["available", "transferred_in"];

/**
 * Per-product AVAILABLE stock for a dealer, for the WhatsApp "Inventory" view.
 * Serialized batteries/chargers are counted one-per-`inventory` row (excluding
 * paraphernalia_lot invoice receipts); paraphernalia comes from the
 * paraphernalia_stock ledger's available_qty. Empty/zero products are omitted.
 */
export async function getDealerAvailableStock(
  dealerCode: string,
): Promise<DealerStockSummary> {
  const rows: DealerStockRow[] = [];

  // Serialized stock (battery / charger), grouped by product/model.
  const serial = await db
    .select({
      label: sql<string>`coalesce(${products.name}, ${inventory.model_type}, 'Unnamed product')`,
      category: sql<string>`coalesce(${inventory.asset_type}, ${inventory.asset_category}, 'Other')`,
      available: sql<number>`count(*)::int`,
    })
    .from(inventory)
    .leftJoin(products, eq(inventory.product_id, products.id))
    .where(
      and(
        eq(inventory.dealer_id, dealerCode),
        inArray(inventory.status, AVAILABLE_STATUSES),
        sql`${inventory.inventory_type} is distinct from 'paraphernalia_lot'`,
      ),
    )
    .groupBy(
      sql`coalesce(${products.name}, ${inventory.model_type}, 'Unnamed product')`,
      sql`coalesce(${inventory.asset_type}, ${inventory.asset_category}, 'Other')`,
    );
  for (const r of serial) {
    if (r.available > 0) {
      rows.push({ label: r.label, category: r.category, available: r.available });
    }
  }

  // Paraphernalia stock from its ledger.
  const para = await db
    .select({
      label: paraphernaliaStock.item_label,
      available: sql<number>`coalesce(sum(${paraphernaliaStock.available_qty}), 0)::int`,
    })
    .from(paraphernaliaStock)
    .where(eq(paraphernaliaStock.dealer_id, dealerCode))
    .groupBy(paraphernaliaStock.item_label);
  for (const r of para) {
    if (r.available > 0) {
      rows.push({
        label: r.label ?? "Paraphernalia",
        category: "Paraphernalia",
        available: r.available,
      });
    }
  }

  rows.sort((a, b) => b.available - a.available);
  const totalAvailable = rows.reduce((sum, r) => sum + r.available, 0);
  return { rows, totalAvailable };
}

/** Load the onboarding application a WhatsApp session is linked to. */
export async function loadApplication(
  applicationId: string | null,
): Promise<Application | null> {
  if (!applicationId) return null;
  const [row] = await db
    .select()
    .from(dealerOnboardingApplications)
    .where(eq(dealerOnboardingApplications.id, applicationId))
    .limit(1);
  return row ?? null;
}
