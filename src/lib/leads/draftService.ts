// E-170 / plan Part 3 + Part 7 — lead draft service.
//
// The Step-1 lead lifecycle (initialize draft → save partial → commit) as
// reusable functions that take an EXPLICIT actor { dealerCode, dealerUserId }
// instead of a cookie session, so the WhatsApp dealer orchestrator can drive the
// SAME leads/personal_details/lead_products writes the portal route does. A
// WhatsApp-started draft is an ordinary `leads` row (status INCOMPLETE,
// kyc_status='draft') and therefore appears in the portal "My Drafts" too — the
// dealer can finish it on either surface.
//
// Mirrors the write shapes in src/app/api/leads/create/route.ts. The portal
// route still owns its HTTP concerns (auth, account auto-create, Zod); the route
// can be refactored to call this later without behaviour change.

import crypto from "crypto";
import { and, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db/index";
import {
  auditLogs,
  leads,
  personalDetails,
} from "@/lib/db/schema";
import { generateId } from "@/lib/api-utils";
import { recordLeadCapture } from "@/lib/leads/lead-registry";

export interface LeadActor {
  /** dealers.dealer_id → leads.dealer_id (E-105 gate value). */
  dealerCode: string;
  /** users.id → leads.uploader_id. */
  dealerUserId: string | null;
}

/** Normalise an Indian mobile to +91XXXXXXXXXX, mirroring the create route. */
function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  let clean = phone.replace(/[^0-9]/g, "");
  if (clean.length === 12 && clean.startsWith("91")) clean = clean.substring(2);
  if (clean.length === 10) return `+91${clean}`;
  return phone.startsWith("+") ? phone : `+91${clean}`;
}

// Numeric-max reference sequence (not lexical) — see create route comment: a
// lexical max can reset the counter onto an existing id. #IT-<year>-<7 digits>.
// Exported so WhatsApp-created leads (customer-lead.ts) get the same reference
// format as web/draft leads.
export async function nextReference(): Promise<string> {
  const prefix = `#IT-${new Date().getFullYear()}`;
  const [row] = await db
    .select({
      maxSeq: sql<number | null>`MAX(CAST(NULLIF(REGEXP_REPLACE(SPLIT_PART(${leads.reference_id}, '-', 3), '[^0-9]', '', 'g'), '') AS INTEGER))`,
    })
    .from(leads)
    .where(sql`${leads.reference_id} LIKE ${prefix + "-%"}`);
  const seq = (row?.maxSeq ?? 0) + 1;
  return `${prefix}-${seq.toString().padStart(7, "0")}`;
}

export interface DraftLeadRef {
  leadId: string;
  referenceId: string | null;
  resumed: boolean;
}

/**
 * Resume this dealer-user's open INCOMPLETE draft, or create a new one.
 * Mirrors MODE 1 (initializeDraft) of the create route.
 */
export async function initializeDraftLead(
  actor: LeadActor,
  opts: { fresh?: boolean } = {},
): Promise<DraftLeadRef> {
  if (opts.fresh && actor.dealerUserId) {
    await db
      .update(leads)
      .set({ status: "ABANDONED", updated_at: new Date() })
      .where(
        and(
          eq(leads.uploader_id, actor.dealerUserId),
          eq(leads.status, "INCOMPLETE"),
        ),
      );
  } else if (actor.dealerUserId) {
    const [existing] = await db
      .select({ id: leads.id, reference_id: leads.reference_id })
      .from(leads)
      .where(
        and(
          eq(leads.uploader_id, actor.dealerUserId),
          eq(leads.status, "INCOMPLETE"),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        leadId: existing.id,
        referenceId: existing.reference_id,
        resumed: true,
      };
    }
  }

  const leadId = await generateId("LEAD");
  const referenceId = await nextReference();

  await db.transaction(async (tx) => {
    await tx.insert(leads).values({
      id: leadId,
      reference_id: referenceId,
      dealer_id: actor.dealerCode,
      uploader_id: actor.dealerUserId,
      status: "INCOMPLETE",
      workflow_step: 1,
      lead_source: "dealer_referral",
      owner_name: "DRAFT",
      owner_contact: "DRAFT",
    });
    await tx.insert(personalDetails).values({
      id: crypto.randomUUID(),
      lead_id: leadId,
      dob: null,
      father_husband_name: null,
    });
  });

  return { leadId, referenceId, resumed: false };
}

/** Fields the WhatsApp capture collects, all optional (incremental). */
export interface LeadDraftPatch {
  full_name?: string | null;
  phone?: string | null;
  email?: string | null;
  dob?: string | null; // YYYY-MM-DD
  current_address?: string | null;
  permanent_address?: string | null;
  is_current_same?: boolean;
  state?: string | null;
  city?: string | null;
  father_or_husband_name?: string | null;
  product_category_id?: string | null;
  primary_product_id?: string | null;
  product_type_id?: string | null;
  asset_type?: string | null;
  interest_level?: "hot" | "warm" | "cold" | null;
  payment_method?: "finance" | "cash" | "other_finance" | "dealer_finance" | null;
  resident_status?: "owned" | "rented" | null;
  has_health_insurance?: boolean | null;
  has_life_insurance?: boolean | null;
}

const FINANCE_METHODS = new Set(["finance", "other_finance", "dealer_finance"]);

/**
 * PARTIAL autosave — writes only the keys present in `patch` (so a per-turn
 * WhatsApp update never nulls a field the dealer already gave). Keeps the lead
 * INCOMPLETE + kyc_status='draft' so it surfaces in "My Drafts". Returns nothing;
 * throws on DB error so the caller can surface a retry.
 */
export async function saveLeadDraftFields(
  leadId: string,
  patch: LeadDraftPatch,
): Promise<void> {
  const set: Record<string, unknown> = {
    kyc_status: "draft",
    status: "INCOMPLETE",
    workflow_step: 1,
    updated_at: new Date(),
  };

  if (patch.full_name !== undefined) {
    const v = patch.full_name?.trim() || null;
    set.full_name = v;
    set.owner_name = v || "DRAFT"; // owner_name is NOT NULL
  }
  if (patch.phone !== undefined) {
    const v = normalizePhone(patch.phone);
    set.phone = v;
    set.mobile = v;
    set.owner_contact = v || "DRAFT"; // owner_contact is NOT NULL
  }
  if (patch.email !== undefined) set.owner_email = patch.email?.trim() || null;
  if (patch.dob !== undefined) set.dob = patch.dob ? new Date(patch.dob) : null;
  if (patch.current_address !== undefined)
    set.current_address = patch.current_address?.trim() || null;
  if (patch.permanent_address !== undefined)
    set.permanent_address = patch.permanent_address?.trim() || null;
  if (patch.is_current_same !== undefined)
    set.is_current_same = patch.is_current_same;
  if (patch.state !== undefined) set.state = patch.state?.trim() || null;
  if (patch.city !== undefined) set.city = patch.city?.trim() || null;
  if (patch.father_or_husband_name !== undefined)
    set.father_or_husband_name = patch.father_or_husband_name?.trim() || null;
  if (patch.product_category_id !== undefined)
    set.product_category_id = patch.product_category_id || null;
  if (patch.primary_product_id !== undefined)
    set.primary_product_id = patch.primary_product_id || null;
  if (patch.product_type_id !== undefined)
    set.product_type_id = patch.product_type_id || null;
  if (patch.asset_type !== undefined) set.asset_type = patch.asset_type ?? null;
  if (patch.interest_level !== undefined)
    set.interest_level = patch.interest_level || null;
  if (patch.payment_method !== undefined)
    set.payment_method = patch.payment_method || null;
  if (patch.resident_status !== undefined)
    set.resident_status = patch.resident_status || null;
  if (patch.has_health_insurance !== undefined)
    set.has_health_insurance = patch.has_health_insurance;
  if (patch.has_life_insurance !== undefined)
    set.has_life_insurance = patch.has_life_insurance;

  await db
    .update(leads)
    .set(set as any)
    .where(eq(leads.id, leadId));
}

export type CommitLeadResult =
  | { ok: true; leadId: string; isCashLike: boolean; isHot: boolean }
  | { ok: false; error: string };

/**
 * Validate + commit a draft to an ACTIVE lead. Mirrors MODE 2 (commitStep) of
 * the create route, including the kyc_status / workflow_step routing matrix.
 * Reads the lead's currently-saved columns (the WhatsApp capture has been
 * autosaving them), so the caller need only ensure the fields are present.
 */
export async function commitLeadDraft(
  leadId: string,
  performedBy: string | null,
): Promise<CommitLeadResult> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  if (!lead) return { ok: false, error: "Lead not found." };

  const fullName = (lead.full_name || "").trim();
  if (fullName.length < 2) return { ok: false, error: "Customer name is required." };
  if (!lead.phone || lead.phone.replace(/\D/g, "").length < 10)
    return { ok: false, error: "A valid mobile number is required." };
  if (!lead.dob) return { ok: false, error: "Date of birth is required." };
  const age = new Date().getFullYear() - new Date(lead.dob).getFullYear();
  if (age < 18) return { ok: false, error: "Customer must be at least 18." };
  if (!lead.product_category_id) return { ok: false, error: "Product category is required." };
  if (!lead.primary_product_id) return { ok: false, error: "Product is required." };
  if (!lead.interest_level) return { ok: false, error: "Interest level is required." };
  // Email is optional — only its format is checked when one was captured.
  const email = (lead.owner_email || "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return { ok: false, error: "Enter a valid customer email address." };
  if (!lead.state?.trim()) return { ok: false, error: "State is required." };
  if (!lead.city?.trim()) return { ok: false, error: "City is required." };

  const isFinance = FINANCE_METHODS.has((lead.payment_method || "").toLowerCase());
  if (isFinance) {
    if (lead.resident_status !== "owned" && lead.resident_status !== "rented")
      return { ok: false, error: "Resident status is required for finance leads." };
    if (typeof lead.has_health_insurance !== "boolean")
      return { ok: false, error: "Health-insurance answer is required for finance leads." };
    if (typeof lead.has_life_insurance !== "boolean")
      return { ok: false, error: "Life-insurance answer is required for finance leads." };
  }

  const score =
    lead.interest_level === "hot" ? 90 : lead.interest_level === "warm" ? 60 : 30;
  const isCashLike =
    (lead.payment_method || "").toLowerCase() === "cash" ||
    (lead.payment_method || "").toLowerCase() === "upfront";
  const isHot = lead.interest_level === "hot";

  await db.transaction(async (tx) => {
    await tx
      .update(leads)
      .set({
        lead_score: score,
        kyc_status: isCashLike ? "not_required" : "not_started",
        workflow_step: isCashLike && isHot ? 4 : 1,
        status: "ACTIVE",
        lead_status: "new",
        payment_method: lead.payment_method || "finance",
        updated_at: new Date(),
      } as any)
      .where(eq(leads.id, leadId));

    await tx
      .update(personalDetails)
      .set({
        dob: lead.dob ? new Date(lead.dob) : null,
        father_husband_name: lead.father_or_husband_name?.trim() || null,
        local_address: lead.current_address?.trim() || null,
      } as any)
      .where(eq(personalDetails.lead_id, leadId));

    await tx.insert(auditLogs).values({
      id: `AUDIT-${Date.now()}`,
      entity_type: "lead",
      entity_id: leadId,
      action: "LEAD_CREATED_STEP1",
      changes: { via: "whatsapp" } as any,
      performed_by: performedBy,
      timestamp: new Date(),
    });
  });

  // E-179 central registry — the draft became a real lead (name + phone
  // validated above). Only caller is the WhatsApp dealer console.
  await recordLeadCapture({
    leadType: "customer",
    name: fullName,
    phone: lead.phone,
    sourceChannel: "whatsapp",
    sourceTable: "leads",
    sourceId: leadId,
  });

  return { ok: true, leadId, isCashLike, isHot };
}

/** Read a draft's saved Step-1 fields (for resume / next-missing-field logic). */
export async function getLeadDraft(leadId: string) {
  const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
  return lead ?? null;
}
