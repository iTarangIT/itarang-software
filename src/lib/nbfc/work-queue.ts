/**
 * NBFC Acquire work-queue — live "needs attention" counts for the partner portal.
 *
 * Derived directly from the existing track tables (no notifications table, no
 * read/unread): a number reflects open work right now and disappears when the
 * work is done. Everything is scoped by tenant_id so each NBFC sees only its own
 * queue. The condition builders below are the SINGLE source of truth — both the
 * header/sidebar count (getNbfcWorkQueueCounts) and the Acquire `?need=` filter
 * (getNbfcWorkQueueLeadIds) use them, so badge and filtered list always agree.
 */
import { and, count, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  enachMandates,
  fieldInvestigations,
  leads,
  nbfcLeadAssignments,
  nbfcLoanAgreements,
  videoKycVerifications,
} from "@/lib/db/schema";

export type WorkQueueNeed = "fi" | "vkyc" | "enach" | "agreement";

/** A recently-completed milestone (success), surfaced in the bell's "Recent activity". */
export interface WorkQueueRecentEvent {
  type: "agreement" | "vkyc";
  lead_id: string;
  customer_name: string | null;
  /** ISO timestamp of the success (agreement signed_at / VKYC completed_at). */
  at: string;
}

export interface WorkQueueCounts {
  /** Brand-new applications routed to this NBFC, not yet actioned. */
  acquire_pending: number;
  /** Field Investigations submitted by the agent, awaiting the coordinator's decision. */
  fi: number;
  /** Video KYC in flight, or completed but awaiting accept/reject. */
  vkyc: number;
  /** E-NACH mandates pending / in progress (winning NBFC only). */
  enach: number;
  /** Loan agreements pending / in progress (winning NBFC only). */
  agreement: number;
  /** Sum of the five "needs attention" counts above. */
  attention_total: number;
  /** Recent successes (last 24h): agreements signed + VKYCs submitted. Auto-ages out. */
  recent: WorkQueueRecentEvent[];
  /** Bell badge = attention_total + recent.length (recent successes light the bell). */
  total: number;
}

// Successes from the last 24h surface in "Recent activity"; older ones age out.
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 10;

// ── condition builders (single source of truth) ──────────────────────────────
const acquirePendingWhere = (tenantId: string) =>
  and(eq(nbfcLeadAssignments.tenant_id, tenantId), eq(nbfcLeadAssignments.status, "pending"));

const fiWhere = (tenantId: string) =>
  and(
    eq(fieldInvestigations.tenant_id, tenantId),
    eq(fieldInvestigations.is_current, true),
    eq(fieldInvestigations.status, "submitted"),
  );

const vkycWhere = (tenantId: string) =>
  and(
    eq(videoKycVerifications.tenant_id, tenantId),
    or(
      inArray(videoKycVerifications.status, ["pending", "in_progress"]),
      and(
        inArray(videoKycVerifications.status, ["verified", "failed"]),
        isNull(videoKycVerifications.admin_action),
      ),
    ),
  );

const enachWhere = (tenantId: string) =>
  and(eq(enachMandates.tenant_id, tenantId), inArray(enachMandates.status, ["pending", "in_progress"]));

const agreementWhere = (tenantId: string) =>
  and(eq(nbfcLoanAgreements.tenant_id, tenantId), inArray(nbfcLoanAgreements.status, ["pending", "in_progress"]));

/**
 * Recent successes (last 24h) for the bell's "Recent activity": agreements
 * signed + VKYCs submitted/verified. INNER JOINs `leads` (orphans excluded,
 * customer name for the row). Merged + sorted newest-first, capped.
 */
async function getRecentActivity(tenantId: string, nowMs: number): Promise<WorkQueueRecentEvent[]> {
  const cutoff = new Date(nowMs - RECENT_WINDOW_MS);
  const [agreements, vkycs] = await Promise.all([
    db
      .select({ lead_id: nbfcLoanAgreements.lead_id, at: nbfcLoanAgreements.signed_at, customer_name: leads.full_name })
      .from(nbfcLoanAgreements)
      .innerJoin(leads, eq(leads.id, nbfcLoanAgreements.lead_id))
      .where(
        and(
          eq(nbfcLoanAgreements.tenant_id, tenantId),
          eq(nbfcLoanAgreements.status, "signed"),
          gte(nbfcLoanAgreements.signed_at, cutoff),
        ),
      )
      .orderBy(desc(nbfcLoanAgreements.signed_at))
      .limit(RECENT_LIMIT),
    db
      .select({ lead_id: videoKycVerifications.lead_id, at: videoKycVerifications.completed_at, customer_name: leads.full_name })
      .from(videoKycVerifications)
      .innerJoin(leads, eq(leads.id, videoKycVerifications.lead_id))
      .where(
        and(
          eq(videoKycVerifications.tenant_id, tenantId),
          eq(videoKycVerifications.status, "verified"),
          gte(videoKycVerifications.completed_at, cutoff),
        ),
      )
      .orderBy(desc(videoKycVerifications.completed_at))
      .limit(RECENT_LIMIT),
  ]);

  const events: WorkQueueRecentEvent[] = [
    ...agreements.map((a) => ({ type: "agreement" as const, lead_id: a.lead_id, customer_name: a.customer_name, at: a.at })),
    ...vkycs.map((v) => ({ type: "vkyc" as const, lead_id: v.lead_id, customer_name: v.customer_name, at: v.at })),
  ]
    .filter((e): e is WorkQueueRecentEvent & { at: Date } => e.at != null)
    .map((e) => ({ ...e, at: e.at.toISOString() }));

  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events.slice(0, RECENT_LIMIT);
}

/**
 * Parallel COUNT(*) per category for the current tenant + recent successes.
 * Each count INNER JOINs `leads` so it matches exactly what the Acquire list
 * shows (the list inner-joins leads too) — orphaned assignment/track rows whose
 * lead was deleted are excluded, so the badge never over-counts vs the page.
 */
export async function getNbfcWorkQueueCounts(tenantId: string, nowMs: number): Promise<WorkQueueCounts> {
  const first = (rows: Array<{ c: number }>) => Number(rows[0]?.c ?? 0);
  const [acquire_pending, fi, vkyc, enach, agreement, recent] = await Promise.all([
    db.select({ c: count() }).from(nbfcLeadAssignments)
      .innerJoin(leads, eq(leads.id, nbfcLeadAssignments.lead_id))
      .where(acquirePendingWhere(tenantId)).then(first),
    db.select({ c: count() }).from(fieldInvestigations)
      .innerJoin(leads, eq(leads.id, fieldInvestigations.lead_id))
      .where(fiWhere(tenantId)).then(first),
    db.select({ c: count() }).from(videoKycVerifications)
      .innerJoin(leads, eq(leads.id, videoKycVerifications.lead_id))
      .where(vkycWhere(tenantId)).then(first),
    db.select({ c: count() }).from(enachMandates)
      .innerJoin(leads, eq(leads.id, enachMandates.lead_id))
      .where(enachWhere(tenantId)).then(first),
    db.select({ c: count() }).from(nbfcLoanAgreements)
      .innerJoin(leads, eq(leads.id, nbfcLoanAgreements.lead_id))
      .where(agreementWhere(tenantId)).then(first),
    getRecentActivity(tenantId, nowMs),
  ]);
  const attention_total = acquire_pending + fi + vkyc + enach + agreement;
  return {
    acquire_pending,
    fi,
    vkyc,
    enach,
    agreement,
    attention_total,
    recent,
    total: attention_total + recent.length,
  };
}

/** Distinct lead_ids whose track `need` is open for this tenant — powers the Acquire `?need=` filter. */
export async function getNbfcWorkQueueLeadIds(tenantId: string, need: WorkQueueNeed): Promise<string[]> {
  switch (need) {
    case "fi": {
      const rows = await db
        .selectDistinct({ lead_id: fieldInvestigations.lead_id })
        .from(fieldInvestigations)
        .innerJoin(leads, eq(leads.id, fieldInvestigations.lead_id))
        .where(fiWhere(tenantId));
      return rows.map((r) => r.lead_id);
    }
    case "vkyc": {
      const rows = await db
        .selectDistinct({ lead_id: videoKycVerifications.lead_id })
        .from(videoKycVerifications)
        .innerJoin(leads, eq(leads.id, videoKycVerifications.lead_id))
        .where(vkycWhere(tenantId));
      return rows.map((r) => r.lead_id);
    }
    case "enach": {
      const rows = await db
        .selectDistinct({ lead_id: enachMandates.lead_id })
        .from(enachMandates)
        .innerJoin(leads, eq(leads.id, enachMandates.lead_id))
        .where(enachWhere(tenantId));
      return rows.map((r) => r.lead_id);
    }
    case "agreement": {
      const rows = await db
        .selectDistinct({ lead_id: nbfcLoanAgreements.lead_id })
        .from(nbfcLoanAgreements)
        .innerJoin(leads, eq(leads.id, nbfcLoanAgreements.lead_id))
        .where(agreementWhere(tenantId));
      return rows.map((r) => r.lead_id);
    }
  }
}
