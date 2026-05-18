/**
 * /admin/nbfc — NBFC directory.
 *
 * Server-rendered page: queries the `nbfc` table directly via Drizzle and
 * passes rows to the presentational `NbfcDirectory` component. Honors
 * `?owner=me` to scope to the current viewer's submissions.
 */
import { desc, eq, inArray, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import {
  nbfc,
  nbfcComplianceDocuments,
  nbfcLspAgreements,
  nbfcLspAgreementSigners,
} from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { PageShell, buildNbfcSteps } from "@/components/layout/PageShell";
import { computeNbfcProgress, getStepResumeUrl } from "@/lib/nbfc/admin/progress";
import NbfcDirectory, {
  type NbfcRow,
} from "@/components/admin/nbfc/NbfcDirectory";

export const dynamic = "force-dynamic";

interface SearchParams {
  owner?: string;
}

export default async function AdminNbfcDirectoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  let user;
  try {
    user = await requireAuth();
  } catch {
    redirect("/login");
  }

  const params = await searchParams;
  const ownedFilter = params.owner === "me";

  // Default directory view shows only activated NBFCs — the partners that
  // are actually live in the iTarang ecosystem. Pre-activation NBFCs
  // (draft, pending_admin_review, request_correction, approved) belong in
  // the "My Submitted Drafts" view (?owner=me) and the dedicated approval
  // queues. `?owner=me` skips this filter so the submitter can resume any
  // of their in-flight onboarding work.
  const baseSelect = db
    .select({
      id: nbfc.id,
      nbfcId: nbfc.nbfc_id,
      legalName: nbfc.legal_name,
      shortName: nbfc.short_name,
      status: nbfc.status,
      rbiRegistrationNo: nbfc.rbi_registration_no,
      partnershipDate: nbfc.partnership_date,
      corExpiryDate: nbfc.cor_expiry_date,
      lspAgreementId: nbfc.lsp_agreement_id,
      approvedAt: nbfc.approved_at,
      activatedAt: nbfc.activated_at,
      createdBy: nbfc.created_by,
      createdByAuthId: nbfc.created_by_auth_id,
      createdAt: nbfc.created_at,
    })
    .from(nbfc);
  const rows = await (ownedFilter
    ? baseSelect.orderBy(desc(nbfc.created_at))
    : baseSelect
        .where(eq(nbfc.status, "active"))
        .orderBy(desc(nbfc.created_at)));

  // Batch-fetch per-row wizard progress signals so we can derive each
  // draft's "current step" via computeNbfcProgress. Two cheap IN-list
  // queries beat N+1 round-trips and avoid adding a denormalized column.
  const nbfcIds = rows.map((r) => r.id);
  const docsRows = nbfcIds.length
    ? await db
        .select({ nbfc_id: nbfcComplianceDocuments.nbfc_id })
        .from(nbfcComplianceDocuments)
        .where(inArray(nbfcComplianceDocuments.nbfc_id, nbfcIds))
    : [];
  const nbfcIdsWithDocs = new Set(docsRows.map((r) => r.nbfc_id));

  const lspRows = nbfcIds.length
    ? await db
        .select({
          id: nbfcLspAgreements.id,
          nbfc_id: nbfcLspAgreements.nbfc_id,
          agreement_status: nbfcLspAgreements.agreement_status,
        })
        .from(nbfcLspAgreements)
        .where(inArray(nbfcLspAgreements.nbfc_id, nbfcIds))
        .orderBy(desc(nbfcLspAgreements.id))
    : [];
  const LSP_TERMINAL = new Set(["COMPLETED", "SIGNED"]);
  const nbfcIdsWithSignedLsp = new Set(
    lspRows
      .filter((r) => LSP_TERMINAL.has(r.agreement_status))
      .map((r) => r.nbfc_id),
  );
  // Any agreement row (incl. PENDING_CEO_VERIFICATION) means the NBFC has
  // moved past Documents — used as a fallback for rows whose
  // `nbfc.lsp_agreement_id` FK was never populated (rows submitted before
  // the E-110 FK-propagation fix landed).
  const nbfcIdsWithAnyLsp = new Set(lspRows.map((r) => r.nbfc_id));
  // Latest agreement per NBFC. Prefer the canonical FK
  // `nbfc.lsp_agreement_id` so the directory shows the same agreement row
  // that the trigger, sync helper, approval/review pages, and the proxy
  // download routes use. Falling back to "newest by id" only when the FK
  // is null (legacy rows from before E-110's FK-propagation fix landed).
  // Without this, NBFCs that went through a CEO correction cycle show the
  // ghost re-submitted row (always PENDING_CEO_VERIFICATION, 0/N signed)
  // instead of the actually-signed row the canonical FK points at.
  const lspById = new Map(lspRows.map((r) => [r.id, r]));
  const latestLspByNbfc = new Map<
    number,
    { id: number; status: string }
  >();
  for (const r of rows) {
    const fkRow = r.lspAgreementId ? lspById.get(r.lspAgreementId) : undefined;
    if (fkRow) {
      latestLspByNbfc.set(r.id, {
        id: fkRow.id,
        status: fkRow.agreement_status,
      });
      continue;
    }
    // Fallback for legacy rows: pick the highest-id agreement for this
    // NBFC (lspRows is already DESC-sorted).
    const newest = lspRows.find((l) => l.nbfc_id === r.id);
    if (newest) {
      latestLspByNbfc.set(r.id, {
        id: newest.id,
        status: newest.agreement_status,
      });
    }
  }
  // Per-agreement signer progress — total count and signed count. Pull only
  // for the latest agreement ids so the count matches what the column shows.
  const latestAgreementIds = Array.from(latestLspByNbfc.values()).map(
    (v) => v.id,
  );
  const signerProgressRows = latestAgreementIds.length
    ? await db
        .select({
          agreement_id: nbfcLspAgreementSigners.nbfc_lsp_agreement_id,
          total: sql<number>`COUNT(*)`,
          signed: sql<number>`COUNT(*) FILTER (WHERE ${nbfcLspAgreementSigners.signing_status} = 'signed')`,
        })
        .from(nbfcLspAgreementSigners)
        .where(
          inArray(nbfcLspAgreementSigners.nbfc_lsp_agreement_id, latestAgreementIds),
        )
        .groupBy(nbfcLspAgreementSigners.nbfc_lsp_agreement_id)
    : [];
  const signerProgressByAgreement = new Map<
    number,
    { total: number; signed: number }
  >();
  for (const r of signerProgressRows) {
    signerProgressByAgreement.set(r.agreement_id, {
      total: Number(r.total),
      signed: Number(r.signed),
    });
  }

  // E-108 — ownership is now keyed on `created_by_auth_id` (uuid). Legacy
  // rows (created before E-108) leave this column NULL and won't appear in
  // "My Submitted Drafts" for anyone, which is correct: we don't know who
  // owned them.
  const viewerId = user.id;
  const directoryRows: NbfcRow[] = rows.map((r) => {
    const progress = computeNbfcProgress({
      status: r.status,
      // Treat presence of *any* agreement row as "past Documents" too —
      // covers rows submitted before the FK-propagation fix landed.
      lspAgreementId: nbfcIdsWithAnyLsp.has(r.id)
        ? (r.lspAgreementId ?? 1)
        : (r.lspAgreementId ?? null),
      approvedAt: r.approvedAt ?? null,
      activatedAt: r.activatedAt ?? null,
      hasDocuments: nbfcIdsWithDocs.has(r.id),
      lspSigned: nbfcIdsWithSignedLsp.has(r.id),
    });
    const latestLsp = latestLspByNbfc.get(r.id) ?? null;
    const signerProgress = latestLsp
      ? signerProgressByAgreement.get(latestLsp.id) ?? null
      : null;
    return {
      id: r.id,
      nbfcId: r.nbfcId,
      legalName: r.legalName,
      shortName: r.shortName,
      status: r.status,
      rbiRegistrationNo: r.rbiRegistrationNo,
      partnershipDate: r.partnershipDate ?? null,
      corExpiryDate: r.corExpiryDate ?? null,
      createdAt: r.createdAt?.toISOString?.() ?? null,
      isMine: r.createdByAuthId != null && r.createdByAuthId === viewerId,
      currentStepNumber: progress.currentStepNumber,
      currentStepLabel: progress.currentStepLabel,
      resumeUrl: getStepResumeUrl(progress.activeStep, r.id),
      lspAgreementStatus: latestLsp?.status ?? null,
      lspSignerProgress: signerProgress,
    };
  });

  const viewerRole = (user.role ?? "user").toLowerCase();
  const eyebrow = ownedFilter ? "My Submitted Drafts" : "NBFC Directory";
  const subtitle = ownedFilter
    ? "NBFCs you have created or submitted for CEO approval."
    : "Activated NBFC partners in the iTarang ecosystem.";

  const steps = buildNbfcSteps({ active: "master" });

  return (
    <PageShell
      eyebrow={eyebrow}
      title="NBFC partners"
      subtitle={subtitle}
      breadcrumb={[{ label: "Admin", href: "/admin" }, { label: "NBFC" }]}
      steps={ownedFilter ? steps : undefined}
      actions={
        ownedFilter ? (
          <Link href="/admin/nbfc" className="btn-ghost">
            Show all NBFCs
          </Link>
        ) : null
      }
    >
      <NbfcDirectory
        rows={directoryRows}
        ownedFilter={ownedFilter}
        viewerRole={viewerRole}
      />
    </PageShell>
  );
}
