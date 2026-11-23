/**
 * 23 Nov 2026 (Battery Pool, tasks 8 + 9) — resume a file an NBFC REJECTED,
 * once the customer has provided corrected documents. Admin / sales head only.
 *
 * Three ways out (pure rules in ./resume-rejected-rules.ts):
 *  - same_nbfc   → the declined assignment is re-opened for the same NBFC
 *                  (status pending, fresh assigned_at, so the CIBIL review and
 *                  offer run again). The NBFC + its credit verifier are told.
 *  - other_nbfc  → reselectFinancing() to another lender (same rules as the
 *                  dealer's "choose another lender").
 *  - new_dealer  → a NEW lead (new case) is created under the other dealer
 *                  with the customer's details + KYC documents copied (the
 *                  documents are re-verified; consent is taken again because
 *                  it is printed for one lead). The rejected lead is left
 *                  exactly as it was and is linked as history (lead_resumes).
 *
 * Every resume writes a lead_resumes row + an audit_logs line and fires
 * notifyLeadResumed (iTarang, dealer, lender; WhatsApp via emit()).
 */
import crypto from "crypto";
import { and, desc, eq, inArray, or } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  accounts,
  auditLogs,
  kycDocuments,
  leadResumes,
  leads,
  nbfc,
  nbfcLeadAssignments,
  personalDetails,
  users,
} from "@/lib/db/schema";
import { generateId } from "@/lib/api-utils";

import { decideResume, type ResumeMode } from "./resume-rejected-rules";

export type { ResumeMode } from "./resume-rejected-rules";

export class ResumeError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

async function loadFacts(leadId: string) {
  const [lead] = await db
    .select({
      id: leads.id,
      dealer_id: leads.dealer_id,
      kyc_status: leads.kyc_status,
      payment_method: leads.payment_method,
      full_name: leads.full_name,
      owner_name: leads.owner_name,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!lead) return null;
  const assignments = await db
    .select({
      id: nbfcLeadAssignments.id,
      nbfc_id: nbfcLeadAssignments.nbfc_id,
      tenant_id: nbfcLeadAssignments.tenant_id,
      status: nbfcLeadAssignments.status,
      decision_reason: nbfcLeadAssignments.decision_reason,
      rejection_note: nbfcLeadAssignments.rejection_note,
      decided_at: nbfcLeadAssignments.decided_at,
      nbfc_name: nbfc.short_name,
      nbfc_legal: nbfc.legal_name,
    })
    .from(nbfcLeadAssignments)
    .leftJoin(nbfc, eq(nbfc.id, nbfcLeadAssignments.nbfc_id))
    .where(eq(nbfcLeadAssignments.lead_id, leadId))
    .orderBy(desc(nbfcLeadAssignments.decided_at));
  const movedOn = await db
    .select({ new_lead_id: leadResumes.new_lead_id })
    .from(leadResumes)
    .where(and(eq(leadResumes.old_lead_id, leadId), eq(leadResumes.mode, "new_dealer")))
    .limit(1);
  return { lead, assignments, movedToLeadId: movedOn[0]?.new_lead_id ?? null };
}

export async function getResumeView(leadId: string) {
  const f = await loadFacts(leadId);
  if (!f) return null;
  const verdict = decideResume({
    paymentMethod: f.lead.payment_method,
    kycStatus: f.lead.kyc_status,
    assignmentStatuses: f.assignments.map((a) => a.status),
    movedToNewCase: !!f.movedToLeadId,
  });
  const history = await db
    .select()
    .from(leadResumes)
    .where(or(eq(leadResumes.old_lead_id, leadId), eq(leadResumes.new_lead_id, leadId)))
    .orderBy(desc(leadResumes.created_at));
  return {
    can_resume: verdict.ok,
    blocked_reason: verdict.ok ? null : verdict.reason,
    dealer_id: f.lead.dealer_id,
    moved_to_lead_id: f.movedToLeadId,
    rejections: f.assignments
      .filter((a) => a.status === "declined")
      .map((a) => ({
        assignment_id: a.id,
        nbfc_id: a.nbfc_id,
        nbfc_name: a.nbfc_name || a.nbfc_legal || `NBFC #${a.nbfc_id}`,
        reason: a.rejection_note ?? a.decision_reason ?? null,
        decided_at: a.decided_at?.toISOString() ?? null,
      })),
    history: history.map((h) => ({
      id: h.id,
      old_lead_id: h.old_lead_id,
      new_lead_id: h.new_lead_id,
      mode: h.mode,
      from_dealer_id: h.from_dealer_id,
      to_dealer_id: h.to_dealer_id,
      rejection_reason: h.rejection_reason,
      note: h.note,
      by: h.resumed_by_name,
      at: h.created_at.toISOString(),
    })),
  };
}

type Actor = { id: string; name: string | null; role: string };

export async function resumeRejectedLead(opts: {
  leadId: string;
  mode: ResumeMode;
  note: string;
  actor: Actor;
  /** same_nbfc: which declined assignment (default: the latest). */
  assignmentId?: string | null;
  /** other_nbfc */
  nbfcId?: number | null;
  loanProductId?: number | null;
  /** new_dealer */
  newDealerId?: string | null;
}): Promise<{ leadId: string; mode: ResumeMode; nbfcName: string | null }> {
  const note = opts.note.trim().slice(0, 1000);
  if (!note) throw new ResumeError("Write what the customer corrected (required)");
  const f = await loadFacts(opts.leadId);
  if (!f) throw new ResumeError("Lead not found", 404);
  const verdict = decideResume({
    paymentMethod: f.lead.payment_method,
    kycStatus: f.lead.kyc_status,
    assignmentStatuses: f.assignments.map((a) => a.status),
    movedToNewCase: !!f.movedToLeadId,
  });
  if (!verdict.ok) throw new ResumeError(verdict.reason, 409);

  const declined = f.assignments.filter((a) => a.status === "declined");
  const lastRejection = declined[0] ?? null;
  const now = new Date();

  if (opts.mode === "same_nbfc") {
    const target = opts.assignmentId ? declined.find((a) => a.id === opts.assignmentId) : lastRejection;
    if (!target) throw new ResumeError("Pick the NBFC rejection to resume");
    await db.transaction(async (tx) => {
      const upd = await tx
        .update(nbfcLeadAssignments)
        .set({
          status: "pending",
          decided_at: null,
          decision_reason: null,
          rejection_note: null,
          rejection_admin_due_at: null,
          rejection_forwarded_at: null,
          rejection_forward_source: null,
          // A new review round: the CIBIL review and the offer start again.
          assigned_at: now,
          updated_at: now,
        })
        .where(and(eq(nbfcLeadAssignments.id, target.id), eq(nbfcLeadAssignments.status, "declined")))
        .returning({ id: nbfcLeadAssignments.id });
      if (!upd.length) throw new ResumeError("This file changed while you were resuming it — reload", 409);
      await tx.insert(leadResumes).values({
        old_lead_id: opts.leadId,
        new_lead_id: opts.leadId,
        from_dealer_id: f.lead.dealer_id,
        to_dealer_id: f.lead.dealer_id,
        mode: "same_dealer",
        rejected_nbfc_id: target.nbfc_id,
        rejection_reason: target.rejection_note ?? target.decision_reason,
        note,
        resumed_by: opts.actor.id,
        resumed_by_name: opts.actor.name,
        created_at: now,
      });
      await tx.insert(auditLogs).values({
        id: `AUDIT-${Date.now()}-resume`,
        entity_type: "lead",
        entity_id: opts.leadId,
        action: "LEAD_RESUMED_AFTER_REJECTION",
        changes: { mode: "same_nbfc", assignment_id: target.id, nbfc_id: target.nbfc_id, note, by_name: opts.actor.name },
        performed_by: opts.actor.id,
        timestamp: now,
      });
    });
    const nbfcName = target.nbfc_name || target.nbfc_legal || null;
    await afterResume({
      leadId: opts.leadId,
      mode: "same_nbfc",
      note,
      actor: opts.actor,
      nbfcTenantId: target.tenant_id,
      nbfcName,
    });
    return { leadId: opts.leadId, mode: "same_nbfc", nbfcName };
  }

  if (opts.mode === "other_nbfc") {
    if (!opts.nbfcId || !opts.loanProductId) throw new ResumeError("Pick the lender and scheme");
    if (!f.lead.dealer_id) throw new ResumeError("This file has no dealer");
    const { reselectFinancing, ReselectError } = await import("./reselect-financing");
    let r;
    try {
      r = await reselectFinancing({
        leadId: opts.leadId,
        nbfcId: opts.nbfcId,
        loanProductId: opts.loanProductId,
        dealerCode: f.lead.dealer_id,
      });
    } catch (err) {
      if (err instanceof ReselectError) throw new ResumeError(err.message, err.status);
      throw err;
    }
    await db.insert(leadResumes).values({
      old_lead_id: opts.leadId,
      new_lead_id: opts.leadId,
      from_dealer_id: f.lead.dealer_id,
      to_dealer_id: f.lead.dealer_id,
      mode: "same_dealer",
      rejected_nbfc_id: lastRejection?.nbfc_id ?? null,
      rejection_reason: lastRejection?.rejection_note ?? lastRejection?.decision_reason ?? null,
      note: `${note} (sent to ${r.nbfcName})`,
      resumed_by: opts.actor.id,
      resumed_by_name: opts.actor.name,
      created_at: now,
    });
    const [a] = await db
      .select({ tenant_id: nbfcLeadAssignments.tenant_id })
      .from(nbfcLeadAssignments)
      .where(and(eq(nbfcLeadAssignments.lead_id, opts.leadId), eq(nbfcLeadAssignments.nbfc_id, opts.nbfcId)))
      .limit(1);
    await afterResume({
      leadId: opts.leadId,
      mode: "other_nbfc",
      note,
      actor: opts.actor,
      nbfcTenantId: a?.tenant_id ?? null,
      nbfcName: r.nbfcName,
      // reselectFinancing already told the verifiers of the new lender.
      skipVerifierNotice: true,
    });
    return { leadId: opts.leadId, mode: "other_nbfc", nbfcName: r.nbfcName };
  }

  // new_dealer — a new case for that dealer; the rejected lead stays as history.
  const code = (opts.newDealerId ?? "").trim();
  if (!code) throw new ResumeError("Pick the dealer for the new case");
  if (code === f.lead.dealer_id) throw new ResumeError("That is the same dealer — use “Same dealer” instead");
  const { findActiveDealerById } = await import("./dealerByMobile");
  const dealer = await findActiveDealerById(code);
  if (!dealer) throw new ResumeError("Dealer not found, not approved, or closed", 404);
  if (!dealer.financeEnabled) throw new ResumeError(`${dealer.name} is not enabled for finance leads`);

  const newLeadId = await copyLeadForDealer({
    oldLeadId: opts.leadId,
    dealerCode: dealer.dealerId,
    actor: opts.actor,
    now,
  });
  await db.insert(leadResumes).values({
    old_lead_id: opts.leadId,
    new_lead_id: newLeadId,
    from_dealer_id: f.lead.dealer_id,
    to_dealer_id: dealer.dealerId,
    mode: "new_dealer",
    rejected_nbfc_id: lastRejection?.nbfc_id ?? null,
    rejection_reason: lastRejection?.rejection_note ?? lastRejection?.decision_reason ?? null,
    note,
    resumed_by: opts.actor.id,
    resumed_by_name: opts.actor.name,
    created_at: now,
  });
  await db.insert(auditLogs).values([
    {
      id: `AUDIT-${Date.now()}-resume-old`,
      entity_type: "lead",
      entity_id: opts.leadId,
      action: "LEAD_RESUMED_AS_NEW_CASE",
      changes: { new_lead_id: newLeadId, to_dealer_id: dealer.dealerId, to_dealer_name: dealer.name, note, by_name: opts.actor.name },
      performed_by: opts.actor.id,
      timestamp: now,
    },
    {
      id: `AUDIT-${Date.now()}-resume-new`,
      entity_type: "lead",
      entity_id: newLeadId,
      action: "LEAD_CREATED_FROM_REJECTED_CASE",
      changes: { old_lead_id: opts.leadId, from_dealer_id: f.lead.dealer_id, note, by_name: opts.actor.name },
      performed_by: opts.actor.id,
      timestamp: now,
    },
  ]);
  await afterResume({ leadId: newLeadId, mode: "new_dealer", note, actor: opts.actor, oldLeadId: opts.leadId });
  return { leadId: newLeadId, mode: "new_dealer", nbfcName: null };
}

/** Customer columns carried to the new case. Lifecycle columns start fresh. */
export async function copyLeadForDealer(opts: { oldLeadId: string; dealerCode: string; actor: Actor; now: Date }): Promise<string> {
  const [old] = await db.select().from(leads).where(eq(leads.id, opts.oldLeadId)).limit(1);
  if (!old) throw new ResumeError("Lead not found", 404);
  // leads.dealer_id references accounts.id — a dealer without its account row
  // cannot own a lead.
  const [acct] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, opts.dealerCode)).limit(1);
  if (!acct) throw new ResumeError("This dealer has no account record yet — finish its onboarding first", 409);
  // The receiving dealer's own login owns the new lead when there is one.
  const [dealerUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.dealer_id, opts.dealerCode), eq(users.role, "dealer"), eq(users.is_active, true)))
    .limit(1);
  const { nextReference } = await import("./draftService");
  const newLeadId = await generateId("LEAD");
  const referenceId = await nextReference();

  await db.transaction(async (tx) => {
    await tx.insert(leads).values({
      id: newLeadId,
      reference_id: referenceId,
      dealer_id: opts.dealerCode,
      uploader_id: dealerUser?.id ?? old.uploader_id,
      lead_source: old.lead_source,
      lead_type: old.lead_type,
      source_channel: old.source_channel,
      owner_name: old.owner_name,
      owner_contact: old.owner_contact,
      owner_email: old.owner_email,
      phone: old.phone,
      mobile: old.mobile,
      full_name: old.full_name,
      father_or_husband_name: old.father_or_husband_name,
      dob: old.dob,
      permanent_address: old.permanent_address,
      local_address: old.local_address,
      current_address: old.current_address,
      is_current_same: old.is_current_same,
      state: old.state,
      city: old.city,
      vehicle_ownership: old.vehicle_ownership,
      vehicle_rc: old.vehicle_rc,
      vehicle_owner_name: old.vehicle_owner_name,
      vehicle_owner_phone: old.vehicle_owner_phone,
      battery_type: old.battery_type,
      asset_model: old.asset_model,
      asset_price: old.asset_price,
      asset_type: old.asset_type,
      family_members: old.family_members,
      driving_experience: old.driving_experience,
      loan_required: old.loan_required,
      interest_level: old.interest_level,
      payment_method: old.payment_method,
      product_category_id: old.product_category_id,
      product_type_id: old.product_type_id,
      primary_product_id: old.primary_product_id,
      interested_in: old.interested_in,
      resident_status: old.resident_status,
      has_health_insurance: old.has_health_insurance,
      has_life_insurance: old.has_life_insurance,
      requested_loan_amount: old.requested_loan_amount,
      has_co_borrower: old.has_co_borrower,
      // A new case: KYC is re-verified and consent taken again for this lead.
      status: "new",
      kyc_status: "pending",
      consent_status: "pending",
      workflow_step: 2,
      assignment_status: "assigned",
      dealer_assigned_at: opts.now,
      dealer_assigned_by: opts.actor.id,
      remarks: `New case from rejected file ${opts.oldLeadId}`,
      created_at: opts.now,
      updated_at: opts.now,
    });

    const [pd] = await tx.select().from(personalDetails).where(eq(personalDetails.lead_id, opts.oldLeadId)).limit(1);
    if (pd) {
      const { id: _id, lead_id: _l, created_at: _c, updated_at: _u, ...rest } = pd;
      void _id; void _l; void _c; void _u;
      await tx.insert(personalDetails).values({ ...rest, id: crypto.randomUUID(), lead_id: newLeadId });
    }

    // The customer's (corrected) KYC documents, re-verified on the new case.
    const docs = await tx
      .select()
      .from(kycDocuments)
      .where(and(eq(kycDocuments.lead_id, opts.oldLeadId), inArray(kycDocuments.doc_for, ["customer", "co_borrower"])));
    for (const d of docs) {
      if (!d.file_url) continue;
      const { id: _id, lead_id: _l, created_at: _c, updated_at: _u, verified_at: _v, verified_by: _vb, ...rest } = d;
      void _id; void _l; void _c; void _u; void _v; void _vb;
      await tx.insert(kycDocuments).values({
        ...rest,
        id: `KYCDOC-${crypto.randomUUID()}`,
        lead_id: newLeadId,
        verification_status: "pending",
        doc_status: "uploaded",
        rejection_reason: null,
        failed_reason: null,
        created_at: opts.now,
        updated_at: opts.now,
      });
    }
  });
  return newLeadId;
}

async function afterResume(p: {
  leadId: string;
  mode: ResumeMode;
  note: string;
  actor: Actor;
  oldLeadId?: string | null;
  nbfcTenantId?: string | null;
  nbfcName?: string | null;
  skipVerifierNotice?: boolean;
}) {
  try {
    const { notifyLeadResumed } = await import("@/lib/notifications/events");
    await notifyLeadResumed({
      leadId: p.leadId,
      mode: p.mode,
      oldLeadId: p.oldLeadId ?? null,
      nbfcTenantId: p.nbfcTenantId ?? null,
      nbfcName: p.nbfcName ?? null,
      note: p.note,
      byName: p.actor.name,
    });
  } catch (err) {
    console.error("[resume-rejected] notification failed", err);
  }
  if (p.mode === "same_nbfc" && !p.skipVerifierNotice) {
    void import("@/lib/nbfc/cibil-review")
      .then((m) => m.notifyCibilVerifiersOfAssignment(p.leadId, { force: true }))
      .catch(() => {});
  }
}
