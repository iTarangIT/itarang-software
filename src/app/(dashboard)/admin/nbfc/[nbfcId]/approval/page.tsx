/**
 * Step 4 — /admin/nbfc/{nbfcId}/approval
 *
 * Lands here after the admin clicks "Send to CEO for Verification" at
 * Step 3. Surfaces every piece of data the CEO needs to verify before
 * approving: master details (Step 1), compliance documents (Step 2),
 * signatories + identity documents (Step 3), and the agreement template
 * (Step 3) with blank + auto-filled previews.
 *
 * The existing final-approval panel renders at the bottom and only
 * unlocks once the wizard reaches Step 4+ — same gating as /review.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  nbfc,
  nbfcComplianceDocuments,
  nbfcCorrectionItems,
  nbfcCorrectionRounds,
  nbfcLspAgreements,
  nbfcLspAgreementSigners,
  nbfcStatusHistory,
} from "@/lib/db/schema";
import NbfcActivationButton from "@/components/admin/nbfc/NbfcActivationButton";
import NbfcFinalApprovalPanel from "@/components/admin/nbfc/NbfcFinalApprovalPanel";
import NbfcMasterDetailsView from "@/components/admin/nbfc/NbfcMasterDetailsView";
import NbfcReviewDocumentsSection from "@/components/admin/nbfc/NbfcReviewDocumentsSection";
import NbfcReviewSignersSection from "@/components/admin/nbfc/NbfcReviewSignersSection";
import NbfcReviewAgreementSection from "@/components/admin/nbfc/NbfcReviewAgreementSection";
import type { SignerForOverlay } from "@/components/admin/nbfc/NbfcReviewAgreementSection";
import NbfcLspSignerStatusPanel, {
  type SignerStatusRow,
  type SignerStatusPanelAgreement,
} from "@/components/admin/nbfc/NbfcLspSignerStatusPanel";
import NbfcStatusBanner from "@/components/admin/nbfc/NbfcStatusBanner";
import NbfcOutstandingCorrectionsPanel, {
  type OutstandingItem,
  type OutstandingRound,
} from "@/components/admin/nbfc/NbfcOutstandingCorrectionsPanel";
import {
  CorrectionFlagProvider,
  type LatestRoundSummary,
  type ResolvedItemSnapshot,
} from "@/components/admin/nbfc/correction-flag-context";
import { NbfcReadinessSignalProvider } from "@/components/admin/nbfc/NbfcReadinessSignal";
import {
  type CorrectionKind,
  labelFor,
  sectionFor,
} from "@/lib/nbfc/admin/correction-catalog";
import {
  buildLatestDocByType,
  computeEffectiveResolution,
  type LiveCorrectionData,
} from "@/lib/nbfc/admin/correction-resolver";
import { PageShell, buildNbfcSteps } from "@/components/layout/PageShell";
import { computeNbfcProgress, getStepNavHref } from "@/lib/nbfc/admin/progress";
import { syncLspSignerStatusFromDigio } from "@/lib/nbfc/admin/sync-lsp-signer-status";

export const dynamic = "force-dynamic";

export default async function NbfcApprovalPage({
  params,
}: {
  params: Promise<{ nbfcId: string }>;
}) {
  const { nbfcId } = await params;
  const id = Number.parseInt(nbfcId, 10);

  if (!Number.isInteger(id) || id <= 0) {
    return (
      <PageShell title="Approval" subtitle={`Invalid NBFC id: ${nbfcId}`}>
        <div
          className="card-iTarang p-6 text-sm"
          style={{ color: "var(--color-danger)" }}
        >
          The NBFC id in the URL is not a valid integer.
        </div>
      </PageShell>
    );
  }

  const [row] = await db.select().from(nbfc).where(eq(nbfc.id, id)).limit(1);

  if (!row) {
    return (
      <PageShell title="Approval" subtitle={`NBFC ${nbfcId} not found`}>
        <div
          className="card-iTarang p-6 text-sm"
          style={{ color: "var(--color-danger)" }}
        >
          No NBFC with id {id}.
        </div>
      </PageShell>
    );
  }

  const docs = await db
    .select()
    .from(nbfcComplianceDocuments)
    .where(eq(nbfcComplianceDocuments.nbfc_id, id));

  // Reconcile signing state with Digio before reading rows — Digio's webhook
  // misroutes for the NBFC flow (lands on /api/webhooks/digio which only
  // updates dealer consent records), so per-signer `signing_status` is
  // stranded on `sent`. This pull is best-effort and idempotent.
  await syncLspSignerStatusFromDigio(id);

  // Prefer the canonical FK (`nbfc.lsp_agreement_id`) over a created_at sort.
  // The trigger and sync helper both look up via the FK, so reading via FK
  // here keeps all three aligned. Fallback to most-recent row for legacy
  // NBFCs where the FK was never backfilled.
  const [agreement] = row.lsp_agreement_id
    ? await db
        .select()
        .from(nbfcLspAgreements)
        .where(eq(nbfcLspAgreements.id, row.lsp_agreement_id))
        .limit(1)
    : await db
        .select()
        .from(nbfcLspAgreements)
        .where(eq(nbfcLspAgreements.nbfc_id, id))
        .orderBy(desc(nbfcLspAgreements.created_at))
        .limit(1);

  const signerRows = agreement
    ? await db
        .select()
        .from(nbfcLspAgreementSigners)
        .where(eq(nbfcLspAgreementSigners.nbfc_lsp_agreement_id, agreement.id))
        .orderBy(nbfcLspAgreementSigners.signer_order)
    : [];

  const lspTerminalRows = await db
    .select({ id: nbfcLspAgreements.id })
    .from(nbfcLspAgreements)
    .where(
      and(
        eq(nbfcLspAgreements.nbfc_id, id),
        inArray(nbfcLspAgreements.agreement_status, ["COMPLETED", "SIGNED"]),
      ),
    )
    .limit(1);

  // Latest status-history reason — drives the banner's subline for
  // rejected / request_correction states. `nbfc` itself has no
  // rejection_reason column; it lives on the transition history row.
  const latestRejection =
    row.status === "rejected" || row.status === "request_correction"
      ? (
          await db
            .select({ reason: nbfcStatusHistory.reason })
            .from(nbfcStatusHistory)
            .where(
              and(
                eq(nbfcStatusHistory.nbfc_id, id),
                inArray(nbfcStatusHistory.to_status, [
                  "rejected",
                  "request_correction",
                ]),
              ),
            )
            .orderBy(desc(nbfcStatusHistory.occurred_at))
            .limit(1)
        )[0]?.reason ?? null
      : null;

  const progress = computeNbfcProgress({
    status: row.status,
    // Prefer the latest agreement row's id over the FK on the parent — older
    // rows submitted before E-110's FK-propagation fix won't have
    // `nbfc.lsp_agreement_id` set even though they have a real agreement row,
    // and the stepper otherwise stays stuck on Documents.
    lspAgreementId: agreement?.id ?? row.lsp_agreement_id ?? null,
    approvedAt: row.approved_at ?? null,
    activatedAt: row.activated_at ?? null,
    hasDocuments: docs.length > 0,
    lspSigned: lspTerminalRows.length > 0,
  });

  const steps = buildNbfcSteps({
    active: progress.activeStep,
    done: progress.doneSteps,
  });

  const showFinalApproval =
    progress.activeStep === "approval" ||
    progress.activeStep === "activation";

  // E-112 — once the CEO has approved AND fired Digio, the admin/CEO no
  // longer need the master/docs/signers cards above the agreement; they've
  // been signed off and are immutable until reset. Hide them so the page
  // collapses to the signing/download surface.
  const postApproval =
    row.status === "approved" || row.status === "active";

  const signerStatusRows: SignerStatusRow[] = signerRows.map((s) => ({
    id: s.id,
    signer_order: s.signer_order,
    party: s.party === "nbfc" ? "nbfc" : "itarang",
    full_name: s.full_name,
    email: s.email,
    designation: s.designation,
    signing_status: s.signing_status ?? "pending",
    signed_at:
      s.signed_at instanceof Date
        ? s.signed_at.toISOString()
        : s.signed_at ?? null,
  }));

  const signerStatusAgreement: SignerStatusPanelAgreement | null = agreement
    ? {
        id: agreement.id,
        agreement_status: agreement.agreement_status ?? null,
        signed_pdf_url: agreement.signed_pdf_url ?? null,
        audit_trail_url: agreement.audit_trail_url ?? null,
        digio_document_id: agreement.digio_document_id ?? null,
        completed_at:
          agreement.completed_at instanceof Date
            ? agreement.completed_at.toISOString()
            : agreement.completed_at ?? null,
      }
    : null;

  const masterDetails = {
    nbfcId: row.nbfc_id,
    legalName: row.legal_name,
    shortName: row.short_name,
    rbiRegistrationNo: row.rbi_registration_no,
    cin: row.cin,
    gstNumber: row.gst_number,
    panNumber: row.pan_number,
    nbfcType: row.nbfc_type,
    registeredAddress: row.registered_address,
    activeGeographies: row.active_geographies,
    primaryContactName: row.primary_contact_name,
    primaryContactEmail: row.primary_contact_email,
    primaryContactPhone: row.primary_contact_phone,
    grievanceOfficerName: row.grievance_officer_name,
    grievanceHelpline: row.grievance_helpline,
    grievanceUrl: row.grievance_url,
    nodalOfficer: row.nodal_officer,
    partnershipDate: row.partnership_date,
    fldgTerms: row.fldg_terms,
    corExpiryDate: row.cor_expiry_date,
  };

  const masterForOverlay = {
    legalName: row.legal_name ?? "",
    shortName: row.short_name ?? "",
    nbfcPublicId: row.nbfc_id ?? "",
    rbiRegistrationNo: row.rbi_registration_no ?? "",
    cin: row.cin ?? "",
    gstNumber: row.gst_number ?? "",
    panNumber: row.pan_number ?? "",
  };

  const signersForOverlay: SignerForOverlay[] = signerRows.map((s) => ({
    fullName: s.full_name,
    email: s.email,
    designation: s.designation,
    party: (s.party === "nbfc" ? "nbfc" : "itarang") as "nbfc" | "itarang",
  }));

  const docRowsForSection = docs.map((d) => ({
    id: d.id,
    document_type: d.document_type,
    file_url: d.file_url,
    status: d.status,
    rejection_reason: d.rejection_reason ?? null,
    expiry_date:
      d.expiry_date instanceof Date
        ? d.expiry_date.toISOString().slice(0, 10)
        : d.expiry_date ?? null,
    created_at:
      d.created_at instanceof Date ? d.created_at.toISOString() : d.created_at,
  }));

  const agreementForSection = agreement
    ? {
        id: agreement.id,
        agreement_id: agreement.agreement_id ?? null,
        agreement_status: agreement.agreement_status ?? null,
        agreement_template_url: agreement.agreement_template_url ?? null,
        agreement_template_size: agreement.agreement_template_size ?? null,
        expires_at:
          agreement.expires_at instanceof Date
            ? agreement.expires_at.toISOString()
            : agreement.expires_at ?? null,
      }
    : null;

  // E-111 — load latest correction round so both the outstanding panel
  // (admin) and the resolved badges (CEO returning to review) can render.
  // Wrapped so the page survives if E-111 tables haven't been applied yet.
  let latestRoundRow:
    | typeof nbfcCorrectionRounds.$inferSelect
    | undefined;
  let latestRoundItemRows: (typeof nbfcCorrectionItems.$inferSelect)[] = [];
  try {
    [latestRoundRow] = await db
      .select()
      .from(nbfcCorrectionRounds)
      .where(eq(nbfcCorrectionRounds.nbfc_id, id))
      .orderBy(desc(nbfcCorrectionRounds.round_number))
      .limit(1);
    latestRoundItemRows = latestRoundRow
      ? await db
          .select()
          .from(nbfcCorrectionItems)
          .where(eq(nbfcCorrectionItems.round_id, latestRoundRow.id))
          .orderBy(nbfcCorrectionItems.id)
      : [];
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[E-111] nbfc_correction_rounds query failed — migration not applied?",
      err instanceof Error ? err.message : err,
    );
  }
  // E-111 — compute effective resolution per item against the live nbfc /
  // docs / agreement / signers data so the panel shows progressive
  // resolution as the admin fixes each item.
  const liveCorrectionData: LiveCorrectionData = {
    nbfcRow: row,
    latestDocByType: buildLatestDocByType(docs),
    agreement: agreement ?? null,
    signers: signerRows,
  };
  const enrichedItems = latestRoundItemRows.map((it) => ({
    raw: it,
    effective: computeEffectiveResolution(it, liveCorrectionData),
  }));
  const effectivePendingCount = enrichedItems.filter(
    (e) => e.effective.resolutionStatus === "pending",
  ).length;

  const outstandingRound: OutstandingRound | null = latestRoundRow
    ? {
        id: latestRoundRow.id,
        roundNumber: latestRoundRow.round_number,
        status: latestRoundRow.status as
          | "open"
          | "resolved"
          | "superseded",
        summaryRemarks: latestRoundRow.summary_remarks,
        items: enrichedItems.map<OutstandingItem>(({ raw, effective }) => ({
          id: raw.id,
          kind: raw.kind as CorrectionKind,
          targetKey: raw.target_key,
          targetRefId: raw.target_ref_id,
          label: labelFor(raw.kind as CorrectionKind, raw.target_key),
          section: sectionFor(raw.kind as CorrectionKind),
          remark: raw.remark,
          previousValue: raw.previous_value,
          previousFileUrl: raw.previous_file_url,
          resolutionStatus: effective.resolutionStatus,
          newValue: effective.newValue,
          newFileUrl: effective.newFileUrl,
        })),
        pendingCount: effectivePendingCount,
        totalCount: latestRoundItemRows.length,
      }
    : null;
  const latestRoundForCtx: LatestRoundSummary | null = latestRoundRow
    ? {
        id: latestRoundRow.id,
        roundNumber: latestRoundRow.round_number,
        status: latestRoundRow.status as
          | "open"
          | "resolved"
          | "superseded",
        items: enrichedItems.map<ResolvedItemSnapshot>(({ raw, effective }) => ({
          kind: raw.kind as CorrectionKind,
          targetKey: raw.target_key,
          resolutionStatus: effective.resolutionStatus,
          previousValue: raw.previous_value,
          previousFileUrl: raw.previous_file_url,
          newValue: effective.newValue,
          newFileUrl: effective.newFileUrl,
          remark: raw.remark,
        })),
        pendingCount: effectivePendingCount,
        totalCount: latestRoundItemRows.length,
      }
    : null;

  return (
    <PageShell
      eyebrow="Approval"
      title={`Awaiting CEO approval`}
      subtitle="Review every piece of data from Steps 1-3 before signing off. Digio signing is triggered only after this approval."
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "NBFC", href: "/admin/nbfc" },
        { label: nbfcId },
        { label: "Approval" },
      ]}
      steps={steps}
      hrefForStep={(step) => getStepNavHref(step, id, row.status)}
    >
      <CorrectionFlagProvider
        nbfcId={id}
        viewerIsCeo={false}
        initialLatestRound={latestRoundForCtx}
      >
        <NbfcReadinessSignalProvider>
          <div className="space-y-10">
            <NbfcStatusBanner
              status={row.status}
              approvedAt={row.approved_at}
              rejectionReason={latestRejection}
              pendingCorrectionCount={outstandingRound?.pendingCount ?? 0}
            />
            {outstandingRound && outstandingRound.status === "open" && (
              <NbfcOutstandingCorrectionsPanel
                nbfcId={id}
                round={outstandingRound}
              />
            )}
            {!postApproval && (
              <>
                <NbfcMasterDetailsView nbfc={masterDetails} />
                <NbfcReviewDocumentsSection docs={docRowsForSection} />
                <NbfcReviewSignersSection signers={signerRows} />
              </>
            )}
            <NbfcReviewAgreementSection
              agreement={agreementForSection}
              master={masterForOverlay}
              signers={signersForOverlay}
            />
            <NbfcLspSignerStatusPanel
              nbfcId={id}
              agreement={signerStatusAgreement}
              signers={signerStatusRows}
              canResend={true}
            />
            {/* Manual activation gate. The approval page is the admin's
                landing surface; CEO approval has already happened and the
                LSP agreement is signed, so this button is what flips the
                NBFC to `active` and issues portal credentials. Server-side
                role enforcement still happens inside
                /api/admin/nbfc/[id]/activate. */}
            {(row.status === "approved" || row.status === "active") &&
              signerStatusAgreement?.agreement_status === "COMPLETED" && (
                <NbfcActivationButton
                  nbfcId={id}
                  initialStatus={row.status}
                />
              )}
            {showFinalApproval && <NbfcFinalApprovalPanel nbfcId={id} />}
          </div>
        </NbfcReadinessSignalProvider>
      </CorrectionFlagProvider>
    </PageShell>
  );
}
