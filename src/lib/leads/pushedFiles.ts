// ID 183 Phase 1 — the "Pushed files" list for the iTarang team (house
// logins, Admin, Sales Head): every customer file the house pushed to a
// dealer, with the dealer, the stage, the last action and its age, until the
// loan is disbursed or the file is closed. These files belong to the dealer
// (counted only under the dealer); this list is how iTarang keeps sight.
//
// Plus Admin's search by customer mobile across ALL dealers (pushed or not).

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, leads, users } from "@/lib/db/schema";
import { houseDealerCode } from "@/lib/leads/dealerByMobile";
import { dealerContacts, LEAD_PUSHED_TO_DEALER } from "@/lib/leads/pushGuards";
import { ACTED_FOR_DEALER } from "@/lib/leads/actForDealer";

/** Files no longer followed on the list: closed, sold or abandoned. */
const DONE_KYC_STATUSES = new Set(["closed_loan_rejected", "sold", "delivered"]);

const STAGE_BY_KYC: Record<string, string> = {
  draft: "Step 1 — customer details",
  pending: "Step 2 — KYC",
  not_started: "Step 2 — KYC",
  in_progress: "Step 2 — KYC",
  not_required: "Cash — product selection",
  docs_requested: "Step 3 — documents asked",
  submitted: "KYC with iTarang",
  pending_itarang_verification: "KYC with iTarang",
  pending_itarang_reverification: "KYC with iTarang",
  completed: "Step 4 — lender pick",
  product_selection_in_progress: "Step 4 — lender pick",
  pending_final_approval: "With the lender",
  awaiting_enach: "Offer picked — E-NACH",
  loan_sanctioned: "Sanctioned — Step 5",
  loan_rejected: "Lender rejected",
  financing_unavailable: "Financing unavailable",
  dispatched: "Dispatched",
  sold: "Sold",
  closed_loan_rejected: "Closed",
};

export function pushedFileStage(kycStatus: string | null | undefined, workflowStep: number | null | undefined): string {
  const k = (kycStatus ?? "").toLowerCase();
  return STAGE_BY_KYC[k] ?? (workflowStep ? `Step ${workflowStep}` : k || "—");
}

/** Plain words for an audit action on the list ("LEAD_PUSHED_TO_DEALER" → "Pushed to dealer"). */
export function actionLabel(action: string | null | undefined): string {
  const a = (action ?? "").trim();
  if (!a) return "—";
  if (a === LEAD_PUSHED_TO_DEALER) return "Pushed to dealer";
  if (a === ACTED_FOR_DEALER) return "iTarang acted for the dealer";
  return a.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export interface PushedFileRow {
  leadId: string;
  referenceId: string | null;
  customerName: string;
  customerMobile: string | null;
  dealer: { dealerId: string | null; name: string | null; mobile: string | null };
  stage: string;
  kycStatus: string | null;
  pushedAt: string | null;
  pushedBy: string | null;
  lastAction: { label: string; at: string; by: string | null } | null;
  ageDays: number | null;
  /** True when the file was pushed out by the house (false only on an Admin mobile search hit). */
  housePushed: boolean;
}

const digits10 = (col: unknown) => sql`right(regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g'), 10)`;

async function disbursedLeadIds(ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  try {
    const rows = (await db.execute(sql`
      SELECT DISTINCT lead_id FROM loan_sanctions
       WHERE disbursed_at IS NOT NULL
         AND lead_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
    `)) as unknown as Array<{ lead_id: string }>;
    return new Set(rows.map((r) => r.lead_id));
  } catch (err) {
    console.error("[pushedFiles] disbursed lookup failed:", err);
    return new Set();
  }
}

/**
 * The list. `mobile` narrows it to one customer; with `acrossDealers` (Admin)
 * the mobile search reaches EVERY dealer's files, pushed or not.
 */
export async function listPushedFiles(opts: { mobile?: string | null; acrossDealers?: boolean } = {}): Promise<PushedFileRow[]> {
  const house = await houseDealerCode();
  const ten = (opts.mobile ?? "").replace(/\D/g, "").slice(-10);
  const mobileFilter = ten.length === 10
    ? sql`(${digits10(leads.mobile)} = ${ten} OR ${digits10(leads.phone)} = ${ten} OR ${digits10(leads.owner_contact)} = ${ten})`
    : null;

  // Every push row from the house, newest first (first push per lead wins below).
  const pushes = house
    ? await db
        .select({ leadId: auditLogs.entity_id, at: auditLogs.timestamp, byName: users.name, changes: auditLogs.changes })
        .from(auditLogs)
        .leftJoin(users, eq(users.id, auditLogs.performed_by))
        .where(
          and(
            eq(auditLogs.entity_type, "lead"),
            eq(auditLogs.action, LEAD_PUSHED_TO_DEALER),
            sql`${auditLogs.changes} ->> 'from_dealer_id' = ${house}`,
          ),
        )
        .orderBy(desc(auditLogs.timestamp))
    : [];
  const pushOf = new Map<string, { at: Date; by: string | null }>();
  for (const p of pushes) {
    if (!p.leadId) continue;
    const c = (p.changes ?? {}) as Record<string, unknown>;
    pushOf.set(p.leadId, { at: p.at instanceof Date ? p.at : new Date(p.at), by: p.byName ?? (typeof c.by_name === "string" ? c.by_name : null) });
  }
  const pushedIds = [...pushOf.keys()];

  const where = opts.acrossDealers && mobileFilter
    ? and(mobileFilter, isNull(leads.deleted_by_admin_at))
    : pushedIds.length
      ? and(inArray(leads.id, pushedIds), isNull(leads.deleted_by_dealer_at), ...(mobileFilter ? [mobileFilter] : []))
      : null;
  if (!where) return [];

  const rows = await db
    .select({
      id: leads.id,
      ref: leads.reference_id,
      name: leads.full_name,
      owner: leads.owner_name,
      mobile: leads.mobile,
      phone: leads.phone,
      dealerId: leads.dealer_id,
      kycStatus: leads.kyc_status,
      workflowStep: leads.workflow_step,
      status: leads.status,
    })
    .from(leads)
    .where(where)
    .orderBy(desc(leads.updated_at))
    .limit(500);

  const ids = rows.map((r) => r.id);
  const [disbursed, contacts, acts] = await Promise.all([
    disbursedLeadIds(ids),
    dealerContacts(rows.map((r) => r.dealerId ?? "").filter(Boolean)),
    ids.length
      ? db
          .selectDistinctOn([auditLogs.entity_id], {
            id: auditLogs.entity_id,
            action: auditLogs.action,
            at: auditLogs.timestamp,
            by: users.name,
          })
          .from(auditLogs)
          .leftJoin(users, eq(users.id, auditLogs.performed_by))
          .where(and(eq(auditLogs.entity_type, "lead"), inArray(auditLogs.entity_id, ids)))
          .orderBy(auditLogs.entity_id, desc(auditLogs.timestamp))
      : Promise.resolve([] as Array<{ id: string | null; action: string | null; at: Date; by: string | null }>),
  ]);
  const lastOf = new Map(acts.filter((a) => a.id).map((a) => [a.id as string, a]));
  const now = Date.now();

  const out: PushedFileRow[] = [];
  for (const r of rows) {
    const housePushed = pushOf.has(r.id);
    // Until disbursed or closed — a mobile search by Admin still shows them.
    const done =
      disbursed.has(r.id) ||
      DONE_KYC_STATUSES.has((r.kycStatus ?? "").toLowerCase()) ||
      (r.status ?? "").toUpperCase() === "ABANDONED";
    if (done && !(opts.acrossDealers && mobileFilter)) continue;
    const push = pushOf.get(r.id);
    const last = lastOf.get(r.id);
    const dealer = r.dealerId ? contacts.get(r.dealerId) : undefined;
    out.push({
      leadId: r.id,
      referenceId: r.ref,
      customerName: r.name || r.owner || "Customer",
      customerMobile: r.mobile || r.phone || null,
      dealer: { dealerId: r.dealerId, name: dealer?.name ?? r.dealerId, mobile: dealer?.mobile ?? null },
      stage: disbursed.has(r.id) ? "Disbursed" : pushedFileStage(r.kycStatus, r.workflowStep),
      kycStatus: r.kycStatus,
      pushedAt: push ? push.at.toISOString() : null,
      pushedBy: push?.by ?? null,
      lastAction: last
        ? { label: actionLabel(last.action), at: new Date(last.at as unknown as string).toISOString(), by: last.by ?? null }
        : null,
      ageDays: push ? Math.max(0, Math.floor((now - push.at.getTime()) / 86_400_000)) : null,
      housePushed,
    });
  }
  return out;
}
