/**
 * Admin page: /admin/nbfc/{nbfcId}/documents — Step 2 of NBFC onboarding.
 * Server component shell that loads the NBFC row + existing compliance
 * documents, then hands them to NbfcDocumentsUploadPanel (client).
 */
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { db } from "@/lib/db";
import { nbfc, nbfcComplianceDocuments } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { PageShell, buildNbfcSteps } from "@/components/layout/PageShell";
import { getStepNavHref } from "@/lib/nbfc/admin/progress";
import NbfcDocumentsUploadPanel from "@/components/admin/nbfc/NbfcDocumentsUploadPanel";
import type { DocRow } from "@/components/admin/nbfc/NbfcDocumentsUploadPanel";
import NbfcReadOnlyBanner from "@/components/admin/nbfc/NbfcReadOnlyBanner";
import { isNbfcLocked } from "@/lib/nbfc/admin/editability";
import NbfcFlaggedItemsAlert from "@/components/admin/nbfc/NbfcFlaggedItemsAlert";
import { loadOpenRoundSummary } from "@/lib/nbfc/admin/correction-loader";

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
      <PageShell
        title="Compliance Documents"
        subtitle={`Invalid NBFC id: ${nbfcId}`}
      >
        <div
          className="card-iTarang p-6 text-sm"
          style={{ color: "var(--color-danger)" }}
        >
          The NBFC id in the URL is not a valid integer.
        </div>
      </PageShell>
    );
  }

  const row =
    (
      await db
        .select({
          id: nbfc.id,
          legal_name: nbfc.legal_name,
          nbfc_id: nbfc.nbfc_id,
          status: nbfc.status,
        })
        .from(nbfc)
        .where(eq(nbfc.id, id))
        .limit(1)
    )[0] ?? null;

  if (!row) {
    return (
      <PageShell title="Compliance Documents" subtitle={`NBFC ${nbfcId} not found`}>
        <div
          className="card-iTarang p-6 text-sm"
          style={{ color: "var(--color-danger)" }}
        >
          No NBFC with id {id}.
        </div>
      </PageShell>
    );
  }

  const docRows = await db
    .select()
    .from(nbfcComplianceDocuments)
    .where(eq(nbfcComplianceDocuments.nbfc_id, id));

  const roundSummary = await loadOpenRoundSummary(id);
  const docFlagged =
    roundSummary?.items.filter(
      (i) => i.section === "compliance_documents",
    ) ?? [];

  const initialDocs: DocRow[] = docRows.map((r) => ({
    id: r.id,
    document_type: r.document_type,
    file_url: r.file_url,
    status: r.status as DocRow["status"],
    rejection_reason: r.rejection_reason,
    // Drizzle's date() column returns a string ('YYYY-MM-DD' | null), so no
    // Date narrowing needed here.
    expiry_date: r.expiry_date ?? null,
    created_at:
      r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  }));

  return (
    <PageShell
      eyebrow="Compliance Documents"
      title="Upload the mandatory documents"
      subtitle={`${row.legal_name} · ${row.nbfc_id}`}
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "NBFC", href: "/admin/nbfc" },
        { label: nbfcId },
        { label: "Documents" },
      ]}
      steps={buildNbfcSteps({ active: "documents", done: ["master"] })}
      hrefForStep={(step) => getStepNavHref(step, id, row.status)}
      actions={
        <Link
          href={`/admin/nbfc/${id}/edit`}
          className="btn-ghost inline-flex items-center gap-1.5"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Master Details
        </Link>
      }
    >
      <div className="space-y-6">
        {isNbfcLocked(row.status) && <NbfcReadOnlyBanner />}
        {roundSummary && docFlagged.length > 0 && (
          <NbfcFlaggedItemsAlert
            section="compliance_documents"
            items={docFlagged}
            roundNumber={roundSummary.roundNumber}
          />
        )}
        <NbfcDocumentsUploadPanel
          nbfcId={id}
          status={row.status}
          initialDocs={initialDocs}
          locked={isNbfcLocked(row.status)}
        />
      </div>
    </PageShell>
  );
}
