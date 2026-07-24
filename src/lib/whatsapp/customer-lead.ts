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

import { and, desc, eq, inArray, isNotNull, ne, notInArray, or, sql } from "drizzle-orm";

import { generateId } from "@/lib/api-utils";
import { db } from "@/lib/db/index";
import { nextReference } from "@/lib/leads/draftService";
import { notifyLeadCreated } from "@/lib/notifications/events";
import {
  adminVerificationQueue,
  dealerOnboardingApplications,
  inventory,
  leads,
  paraphernaliaStock,
  personalDetails,
  products,
  users,
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

/** Email of the fixed "house" dealer that owns WhatsApp customer-onboarding
 *  leads (entry-chooser option 2). Overridable via env. */
const HOUSE_DEALER_EMAIL =
  process.env.WHATSAPP_HOUSE_DEALER_EMAIL?.trim().toLowerCase() ||
  "dealer@itarang.com";

/**
 * Resolve the house dealer (dealer@itarang.com) as an ActiveDealer so a customer
 * self-onboarding over WhatsApp gets their lead attributed to that account. The
 * mapping mirrors an approved dealer: dealer_code = users.dealer_id
 * (= accounts.id = leads.dealer_id FK target); uploader_id = users.id. Returns
 * null when the account is missing, inactive, or not wired to a dealer_id — the
 * caller degrades gracefully instead of creating an orphan lead.
 */
export async function resolveHouseDealer(): Promise<ActiveDealer | null> {
  const [u] = await db
    .select({ id: users.id, dealerId: users.dealer_id })
    .from(users)
    .where(
      and(
        eq(sql`lower(${users.email})`, HOUSE_DEALER_EMAIL),
        eq(users.is_active, true),
      ),
    )
    .limit(1);
  if (!u || !u.dealerId) return null;
  return { dealerCode: u.dealerId, uploaderId: u.id, dealerName: "iTarang" };
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
  // Same #IT-<year>-<7 digits> reference as web/draft leads so the lead shows a
  // proper Lead ID (not the #IT-XXXX-XXXXXXX placeholder) when opened on the web.
  const referenceId = await nextReference();

  await db.transaction(async (tx) => {
    await tx.insert(leads).values({
      id: leadId,
      reference_id: referenceId,
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

  // A WhatsApp lead is real the moment it is inserted — unlike the web wizard
  // there is no draft placeholder stage — so the admin bell fires here.
  // Best-effort: emit() never throws, so it cannot fail the lead creation.
  await notifyLeadCreated({
    leadId,
    customerName: name === PENDING_CUSTOMER_NAME ? null : name,
    paymentMethod,
    source: "whatsapp",
    dealerName: dealer.dealerName || dealer.dealerCode,
  });

  return leadId;
}

/**
 * A lead already in process with iTarang (submitted for KYC review). Returned by
 * the document-identity duplicate check below. (Mobile number is NOT a uniqueness
 * key — the same number may be reused; finance uniqueness is on the documents.)
 */
export interface ExistingFinanceLead {
  leadId: string;
  referenceId: string | null;
  createdAt: Date | null;
}

/**
 * Find a DIFFERENT lead that's already in process with iTarang (submitted for
 * KYC review) whose extracted identity matches the given PAN and/or Aadhaar.
 * Returns the most recent match, or null.
 *
 * Used when a dealer uploads customer documents over WhatsApp: if the PAN /
 * Aadhaar read off the uploaded docs already belongs to a submitted lead, a new
 * lead must not be created for the same person.
 */
export async function findInProcessLeadByIdentity(opts: {
  pan?: string | null;
  aadhaar?: string | null;
  excludeLeadId: string;
}): Promise<ExistingFinanceLead | null> {
  const idMatches = [];
  if (opts.pan) idMatches.push(eq(personalDetails.pan_no, opts.pan));
  if (opts.aadhaar) idMatches.push(eq(personalDetails.aadhaar_no, opts.aadhaar));
  if (idMatches.length === 0) return null;

  const [row] = await db
    .select({
      leadId: leads.id,
      referenceId: leads.reference_id,
      createdAt: leads.created_at,
    })
    .from(personalDetails)
    .innerJoin(leads, eq(leads.id, personalDetails.lead_id))
    .innerJoin(
      adminVerificationQueue,
      eq(adminVerificationQueue.lead_id, leads.id),
    )
    .where(and(or(...idMatches), ne(leads.id, opts.excludeLeadId)))
    .orderBy(desc(leads.created_at))
    .limit(1);
  return row ?? null;
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

/** A pickable product for the WhatsApp lead "Product details" step — one row
 *  per distinct product the dealer has available stock of, with the catalogue
 *  ids needed to populate the lead the same way the web form does. */
export interface DealerProductOption {
  productId: string;
  categoryId: string;
  name: string;
  assetType: string | null;
  available: number;
}

/**
 * Products the dealer has AVAILABLE serialized stock of (battery / charger),
 * grouped by product, with the catalogue ids. Used to build the WhatsApp
 * "pick a product" list and write product_type_id / product_category_id /
 * asset_type / asset_model onto the lead — matching the web Step-1 product cascade.
 */
export async function getDealerProductOptions(
  dealerCode: string,
): Promise<DealerProductOption[]> {
  const rows = await db
    .select({
      productId: products.id,
      categoryId: products.category_id,
      name: products.name,
      assetType: products.asset_type,
      available: sql<number>`count(*)::int`,
    })
    .from(inventory)
    .innerJoin(products, eq(inventory.product_id, products.id))
    .where(
      and(
        eq(inventory.dealer_id, dealerCode),
        inArray(inventory.status, AVAILABLE_STATUSES),
        sql`${inventory.inventory_type} is distinct from 'paraphernalia_lot'`,
      ),
    )
    .groupBy(products.id, products.category_id, products.name, products.asset_type)
    .orderBy(sql`count(*) desc`);
  return rows.filter((r) => r.available > 0);
}

/** Write the chosen product onto the lead (mirrors the web Step-1 product fields). */
export async function setLeadProduct(
  leadId: string,
  option: {
    productId: string;
    categoryId: string;
    name: string;
    assetType: string | null;
  },
): Promise<void> {
  await db
    .update(leads)
    .set({
      product_type_id: option.productId,
      product_category_id: option.categoryId,
      asset_type: option.assetType ?? null,
      asset_model: option.name,
      updated_at: new Date(),
    })
    .where(eq(leads.id, leadId));
}

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
