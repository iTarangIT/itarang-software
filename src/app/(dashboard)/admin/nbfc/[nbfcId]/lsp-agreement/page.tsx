/**
 * E-007 — admin page: /admin/nbfc/{nbfcId}/lsp-agreement
 *
 * Hosts the NbfcLspAgreementPanel client component. The admin lands here
 * directly from Step 2 once all required compliance documents have been
 * uploaded.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { ArrowLeft } from "lucide-react";
import { db } from "@/lib/db";
import {
  nbfc,
  nbfcLspAgreements,
  nbfcLspAgreementSigners,
} from "@/lib/db/schema";
import NbfcLspAgreementPanel from "@/components/admin/nbfc/NbfcLspAgreementPanel";
import NbfcReadOnlyBanner from "@/components/admin/nbfc/NbfcReadOnlyBanner";
import NbfcFlaggedItemsAlert from "@/components/admin/nbfc/NbfcFlaggedItemsAlert";
import { isNbfcLocked } from "@/lib/nbfc/admin/editability";
import { loadOpenRoundSummary } from "@/lib/nbfc/admin/correction-loader";
import { PageShell, buildNbfcSteps } from "@/components/layout/PageShell";
import { getStepNavHref } from "@/lib/nbfc/admin/progress";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ nbfcId: string }>;
}) {
  const { nbfcId } = await params;
  const id = Number.parseInt(nbfcId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return (
      <PageShell title="Agreement" subtitle={`Invalid NBFC id: ${nbfcId}`}>
        <div className="card-iTarang p-6 text-sm" style={{ color: "var(--color-danger)" }}>
          The NBFC id in the URL is not a valid integer.
        </div>
      </PageShell>
    );
  }

  // Master summary feeds the auto-filled preview card. Cheap, single-row read.
  const [row] = await db
    .select({
      legalName: nbfc.legal_name,
      shortName: nbfc.short_name,
      nbfcPublicId: nbfc.nbfc_id,
      rbiRegistrationNo: nbfc.rbi_registration_no,
      cin: nbfc.cin,
      gstNumber: nbfc.gst_number,
      panNumber: nbfc.pan_number,
      status: nbfc.status,
    })
    .from(nbfc)
    .where(eq(nbfc.id, id))
    .limit(1);
  if (!row) notFound();

  const roundSummary = await loadOpenRoundSummary(id);
  const agreementFlagged =
    roundSummary?.items.filter((i) => i.section === "agreement") ?? [];

  // Pre-fill the form when the admin returns after a CEO correction request:
  // load the latest agreement row + its signer rows so name/email/designation/
  // identity-doc/template are not blank on re-entry.
  const [existingAgreement] = await db
    .select({
      id: nbfcLspAgreements.id,
      agreementTemplateUrl: nbfcLspAgreements.agreement_template_url,
      agreementTemplateSize: nbfcLspAgreements.agreement_template_size,
    })
    .from(nbfcLspAgreements)
    .where(eq(nbfcLspAgreements.nbfc_id, id))
    .orderBy(desc(nbfcLspAgreements.created_at))
    .limit(1);

  const existingSigners = existingAgreement
    ? await db
        .select({
          signerOrder: nbfcLspAgreementSigners.signer_order,
          party: nbfcLspAgreementSigners.party,
          fullName: nbfcLspAgreementSigners.full_name,
          email: nbfcLspAgreementSigners.email,
          designation: nbfcLspAgreementSigners.designation,
          identityDocumentUrl: nbfcLspAgreementSigners.identity_document_url,
          identityDocumentSize: nbfcLspAgreementSigners.identity_document_size,
        })
        .from(nbfcLspAgreementSigners)
        .where(
          eq(
            nbfcLspAgreementSigners.nbfc_lsp_agreement_id,
            existingAgreement.id,
          ),
        )
        .orderBy(nbfcLspAgreementSigners.signer_order)
    : [];

  const initialAgreement = existingAgreement
    ? {
        nbfcSigners: existingSigners
          .filter((s) => s.party === "nbfc")
          .map((s) => ({
            fullName: s.fullName ?? "",
            email: s.email ?? "",
            designation: s.designation ?? "",
            identityDocumentUrl: s.identityDocumentUrl ?? "",
            identityDocumentSize: s.identityDocumentSize ?? undefined,
          })),
        itarangSigners: existingSigners
          .filter((s) => s.party === "itarang")
          .map((s) => ({
            fullName: s.fullName ?? "",
            email: s.email ?? "",
            designation: s.designation ?? "",
            identityDocumentUrl: s.identityDocumentUrl ?? "",
            identityDocumentSize: s.identityDocumentSize ?? undefined,
          })),
        agreementTemplateUrl: existingAgreement.agreementTemplateUrl ?? "",
        agreementTemplateSize:
          existingAgreement.agreementTemplateSize ?? undefined,
      }
    : null;

  return (
    <PageShell
      eyebrow="Agreement"
      title="Initiate sequential signing"
      subtitle="Sequential signing through Digio: NBFC signatories first, then iTarang's authorised signatories. Each signer must attach an identity document."
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "NBFC", href: "/admin/nbfc" },
        { label: nbfcId },
        { label: "Agreement" },
      ]}
      steps={buildNbfcSteps({ active: "lsp", done: ["master", "documents"] })}
      hrefForStep={(step) => getStepNavHref(step, id, row.status)}
      actions={
        <Link
          href={`/admin/nbfc/${id}/documents`}
          className="btn-ghost inline-flex items-center gap-1.5"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Documents
        </Link>
      }
    >
      <div className="space-y-6">
        {isNbfcLocked(row.status) && <NbfcReadOnlyBanner />}
        {roundSummary && agreementFlagged.length > 0 && (
          <NbfcFlaggedItemsAlert
            section="agreement"
            items={agreementFlagged}
            roundNumber={roundSummary.roundNumber}
          />
        )}
        <NbfcLspAgreementPanel
          nbfcId={id}
          master={{
            legalName: row.legalName ?? "",
            shortName: row.shortName ?? "",
            nbfcPublicId: row.nbfcPublicId ?? "",
            rbiRegistrationNo: row.rbiRegistrationNo ?? "",
            cin: row.cin ?? "",
            gstNumber: row.gstNumber ?? "",
            panNumber: row.panNumber ?? "",
          }}
          initialAgreement={initialAgreement}
          locked={isNbfcLocked(row.status)}
        />
      </div>
    </PageShell>
  );
}
