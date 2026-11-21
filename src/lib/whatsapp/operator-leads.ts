// 20 Nov — "📋 My Leads" for the WhatsApp OPERATOR hub (iTarang sales person).
//
// Before this an operator who left a customer KYC had no way back to it from
// their own number: the lead stayed with its dealer and only the chat pointer
// was dropped. This module answers "which customer leads did THIS number
// start?" and renders one lead's information card.
//
// "From this number" is the union of:
//   (a) lead_dealer_reviews.initiator_wa_phone = the operator's number (E-390);
//   (b) LEAD_PUSHED_TO_DEALER audit rows via 'whatsapp_operator' performed by
//       the operator's CRM user (leads from before E-390);
//   (c) ctx.op.myLeadIds — recorded by the hub itself, which is the only trace
//       of a Skip (kept with iTarang House) lead.
// Row ids are typeable, so every read re-checks membership in this set.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db/index";
import { auditLogs, consentRecords, kycDocuments, leadDealerReviews, leads } from "@/lib/db/schema";
import { dealerDisplayNames, LEAD_PUSHED_TO_DEALER } from "@/lib/leads/pushGuards";

/** customer-lead.ts's placeholder name for a lead created before the name was asked. */
const PENDING_CUSTOMER_NAME = "Customer";

export const MY_LEADS_PAGE_SIZE = 8;
/** ctx.op.myLeadIds cap — newest kept. */
export const MY_LEAD_IDS_CAP = 50;

export interface OperatorLeadRow {
  leadId: string;
  customerName: string | null;
  mobile: string | null;
  referenceId: string | null;
  dealerId: string | null;
  updatedAt: Date | null;
  kycStatus: string | null;
}

/** Every lead id this operator number started (unordered, not yet filtered). */
async function candidateLeadIds(opts: {
  waPhone: string | null | undefined;
  userId: string | null | undefined;
  ctxLeadIds?: string[] | null;
}): Promise<Set<string>> {
  const ids = new Set<string>((opts.ctxLeadIds ?? []).filter(Boolean));
  if (opts.waPhone) {
    try {
      const rows = await db
        .selectDistinct({ id: leadDealerReviews.lead_id })
        .from(leadDealerReviews)
        .where(eq(leadDealerReviews.initiator_wa_phone, opts.waPhone));
      for (const r of rows) if (r.id) ids.add(r.id);
    } catch (err) {
      // A database without E-390 has no lead_dealer_reviews — the other sources still work.
      console.warn("[WhatsApp/operator-leads] review lookup failed", err instanceof Error ? err.message : String(err));
    }
  }
  if (opts.userId) {
    const rows = await db
      .selectDistinct({ id: auditLogs.entity_id })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entity_type, "lead"),
          eq(auditLogs.action, LEAD_PUSHED_TO_DEALER),
          eq(auditLogs.performed_by, opts.userId),
          sql`${auditLogs.changes} ->> 'via' = 'whatsapp_operator'`,
        ),
      );
    for (const r of rows) if (r.id) ids.add(r.id);
  }
  return ids;
}

function realName(ownerName: string | null, fullName: string | null): string | null {
  const n = (ownerName ?? "").trim();
  if (n && n !== PENDING_CUSTOMER_NAME && n !== "DRAFT") return n;
  return (fullName ?? "").trim() || null;
}

/** The operator's leads, newest activity first (deleted-by-dealer excluded). */
export async function listOperatorLeads(opts: {
  waPhone: string | null | undefined;
  userId: string | null | undefined;
  ctxLeadIds?: string[] | null;
}): Promise<OperatorLeadRow[]> {
  const ids = [...(await candidateLeadIds(opts))];
  if (!ids.length) return [];
  const rows = await db
    .select({
      id: leads.id,
      ownerName: leads.owner_name,
      fullName: leads.full_name,
      mobile: leads.mobile,
      ownerContact: leads.owner_contact,
      referenceId: leads.reference_id,
      dealerId: leads.dealer_id,
      updatedAt: leads.updated_at,
      kycStatus: leads.kyc_status,
    })
    .from(leads)
    .where(and(inArray(leads.id, ids), isNull(leads.deleted_by_dealer_at)))
    .orderBy(desc(leads.updated_at));
  return rows.map((r) => ({
    leadId: r.id,
    customerName: realName(r.ownerName, r.fullName),
    mobile: r.mobile || r.ownerContact || null,
    referenceId: r.referenceId ?? null,
    dealerId: r.dealerId ?? null,
    updatedAt: r.updatedAt ?? null,
    kycStatus: r.kycStatus ?? null,
  }));
}

/** Is `leadId` one this operator number started? (Row ids are typeable.) */
export async function operatorOwnsLead(
  opts: { waPhone: string | null | undefined; userId: string | null | undefined; ctxLeadIds?: string[] | null },
  leadId: string,
): Promise<boolean> {
  if (!leadId) return false;
  return (await candidateLeadIds(opts)).has(leadId);
}

export function maskMobile(m: string | null | undefined): string {
  const d = (m ?? "").replace(/\D/g, "").slice(-10);
  if (d.length < 6) return d || "—";
  return `${d.slice(0, 2)}XXXXX${d.slice(-3)}`;
}

/** One plain-language stage line. */
export function kycStageLabel(kycStatus: string | null | undefined): string {
  const s = String(kycStatus ?? "").toLowerCase();
  if (!s || s === "draft" || s === "pending" || s === "in_progress" || s === "not_started") {
    return "KYC in progress on WhatsApp";
  }
  if (s === "kyc_approved") return "KYC approved — lender step";
  if (s === "loan_sanctioned") return "Loan sanctioned — dispatch next";
  if (s === "dispatched" || s === "sold") return "Battery dispatched — done";
  if (s === "loan_rejected") return "Loan rejected by the lender";
  if (s === "kyc_rejected" || s === "rejected") return "KYC rejected";
  return "KYC under iTarang review";
}

function dealerCheckLabel(status: string | null | undefined): string | null {
  if (status === "pending") return "Waiting for iTarang House to confirm the dealer";
  if (status === "rejected") return "Dealer rejected — pick again";
  if (status === "approved" || status === "changed") return "Dealer confirmed by iTarang House";
  return null;
}

function humanPayment(pm: string | null | undefined): string {
  const p = String(pm ?? "").toLowerCase();
  if (!p) return "not set";
  if (p === "cash" || p === "upfront") return "Cash";
  if (p === "other_finance") return "Other finance";
  return "iTarang finance";
}

export interface OperatorLeadCard {
  leadId: string;
  dealerId: string | null;
  dealerName: string;
  body: string;
}

/** The information card for one lead (caller has already checked ownership). */
export async function operatorLeadCard(leadId: string): Promise<OperatorLeadCard | null> {
  const [l] = await db
    .select({
      id: leads.id,
      ownerName: leads.owner_name,
      fullName: leads.full_name,
      mobile: leads.mobile,
      ownerContact: leads.owner_contact,
      referenceId: leads.reference_id,
      dealerId: leads.dealer_id,
      interest: leads.interest_level,
      paymentMethod: leads.payment_method,
      kycStatus: leads.kyc_status,
      consentStatus: leads.consent_status,
      createdAt: leads.created_at,
    })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  if (!l) return null;

  const [names, review, docs, consent] = await Promise.all([
    dealerDisplayNames(l.dealerId ? [l.dealerId] : []),
    db
      .select({ status: leadDealerReviews.status })
      .from(leadDealerReviews)
      .where(eq(leadDealerReviews.lead_id, leadId))
      .orderBy(desc(leadDealerReviews.created_at))
      .limit(1)
      .then((r) => r[0] ?? null)
      .catch(() => null),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(kycDocuments)
      .where(and(eq(kycDocuments.lead_id, leadId), eq(kycDocuments.doc_for, "customer")))
      .then((r) => Number(r[0]?.n ?? 0))
      .catch(() => 0),
    db
      .select({ status: consentRecords.consent_status, type: consentRecords.consent_type })
      .from(consentRecords)
      .where(eq(consentRecords.lead_id, leadId))
      .orderBy(desc(consentRecords.created_at))
      .limit(1)
      .then((r) => r[0] ?? null)
      .catch(() => null),
  ]);

  const dealerName = l.dealerId ? names.get(l.dealerId) ?? l.dealerId : "—";
  const name = realName(l.ownerName, l.fullName) ?? "Name not captured yet";
  const consentLine = consent?.status
    ? `${consent.status.replace(/_/g, " ")}${consent.type ? ` (${consent.type})` : ""}`
    : (l.consentStatus ?? "not started").replace(/_/g, " ");
  const check = dealerCheckLabel(review?.status);

  const lines = [
    `👤 *${name}*`,
    `📱 ${maskMobile(l.mobile || l.ownerContact)}`,
    `🆔 ${l.referenceId ?? l.id}`,
    `🏪 Dealer: ${dealerName}`,
    `🔥 Interest: ${l.interest ?? "not set"} · 💳 ${humanPayment(l.paymentMethod)}`,
    "",
    `📍 *Stage:* ${kycStageLabel(l.kycStatus)}`,
    ...(check ? [`🏠 ${check}`] : []),
    `✍ Consent: ${consentLine}`,
    `📄 Customer documents: ${docs}`,
    ...(l.createdAt ? [`🕒 Started ${new Date(l.createdAt).toLocaleDateString("en-IN")}`] : []),
  ];
  return { leadId: l.id, dealerId: l.dealerId ?? null, dealerName, body: lines.join("\n") };
}
