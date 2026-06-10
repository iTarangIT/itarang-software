/**
 * /admin/nbfc/financing-offers/approvals — iTarang CEO queue of out-of-band
 * financing-offer deviations awaiting sign-off (BRD Addendum V0.3.1 §13.3.4).
 *
 * Server-rendered. CEO-gated (role='ceo' or email=CEO_EMAIL); the approve/reject
 * API routes are independently CEO-gated. Renders one card per pending
 * `dual_approval_requests` row of action_type='financing_offer_deviation',
 * oldest-first so the closest-to-SLA-breach item is at the top.
 */
import { and, eq, inArray, asc } from "drizzle-orm";
import { redirect } from "next/navigation";

import { db } from "@/lib/db";
import { dualApprovalRequests, nbfc } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { FINANCING_OFFER_DEVIATION_ACTION } from "@/lib/nbfc/dual-approval/service";
import { PageShell } from "@/components/layout/PageShell";
import FinancingOfferDeviationCard, {
  type DeviationRequest,
} from "@/components/admin/nbfc/FinancingOfferDeviationCard";

export const dynamic = "force-dynamic";

const CEO_EMAIL = "sanchit@itarang.com";

type Snapshot = {
  lead_id?: string;
  nbfc_id?: number;
  offer?: DeviationRequest["offer"];
  deviation_reason?: string;
};

export default async function FinancingOfferApprovalsPage() {
  let user;
  try {
    user = await requireAuth();
  } catch {
    redirect("/login");
  }

  const role = (user.role ?? "").toLowerCase();
  const email = (user.email ?? "").toLowerCase();
  const isCeo = role === "ceo" || email === CEO_EMAIL;

  if (!isCeo) {
    return (
      <PageShell
        eyebrow="CEO Only"
        title="Financing Offer Approvals"
        subtitle="Only the iTarang CEO can approve out-of-band financing offers."
        breadcrumb={[{ label: "Admin", href: "/admin" }, { label: "Financing Approvals" }]}
      >
        <div className="card-iTarang p-8" style={{ background: "var(--color-info-bg)", borderColor: "rgba(19, 143, 198, 0.3)" }}>
          <p className="font-semibold text-[color:var(--color-brand-navy)]">Restricted view</p>
          <p className="text-sm text-[color:var(--color-brand-navy)]/80 mt-1">
            This queue is reserved for the iTarang CEO. Your role is <span className="font-mono">{role || "unknown"}</span>.
          </p>
        </div>
      </PageShell>
    );
  }

  const pending = await db
    .select()
    .from(dualApprovalRequests)
    .where(
      and(
        eq(dualApprovalRequests.action_type, FINANCING_OFFER_DEVIATION_ACTION),
        eq(dualApprovalRequests.status, "pending_approval"),
      ),
    )
    .orderBy(asc(dualApprovalRequests.created_at));

  // Resolve NBFC display names from the snapshot's nbfc_id (= nbfc.id PK).
  const nbfcIds = Array.from(
    new Set(pending.map((p) => (p.evidence_snapshot as Snapshot)?.nbfc_id).filter((n): n is number => typeof n === "number")),
  );
  const nbfcRows = nbfcIds.length
    ? await db.select({ id: nbfc.id, short_name: nbfc.short_name, legal_name: nbfc.legal_name }).from(nbfc).where(inArray(nbfc.id, nbfcIds))
    : [];
  const nameById = new Map(nbfcRows.map((r) => [r.id, r.short_name || r.legal_name] as const));

  const rows: DeviationRequest[] = pending.map((p) => {
    const snap = (p.evidence_snapshot as Snapshot) ?? {};
    return {
      id: p.id,
      leadId: snap.lead_id ?? null,
      nbfcName: snap.nbfc_id != null ? nameById.get(snap.nbfc_id) ?? `NBFC #${snap.nbfc_id}` : null,
      createdAt: p.created_at?.toISOString?.() ?? null,
      deviationReason: snap.deviation_reason ?? null,
      offer: snap.offer ?? null,
    };
  });

  return (
    <PageShell
      eyebrow="CEO Queue"
      title="Out-of-band financing offers"
      subtitle={`${rows.length} offer${rows.length === 1 ? "" : "s"} awaiting your approval (4-hour SLA).`}
      breadcrumb={[{ label: "Admin", href: "/admin" }, { label: "Financing Approvals" }]}
    >
      {rows.length === 0 ? (
        <div className="card-iTarang p-8 text-sm text-slate-500">No pending financing-offer deviations. 🎉</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {rows.map((r) => (
            <FinancingOfferDeviationCard key={r.id} req={r} />
          ))}
        </div>
      )}
    </PageShell>
  );
}
