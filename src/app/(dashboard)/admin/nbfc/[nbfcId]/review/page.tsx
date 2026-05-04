"use client";

import { use } from "react";
import NbfcFinalApprovalPanel from "@/components/admin/nbfc/NbfcFinalApprovalPanel";
import { PageShell, buildNbfcSteps } from "@/components/layout/PageShell";

/**
 * E-001 — admin review page for an NBFC. Hosts the final approval gate.
 * Server-side enforcement is in /api/admin/nbfc/[id]/approve; the panel's
 * UI gate is advisory.
 */
export default function NbfcReviewPage({
  params,
}: {
  params: Promise<{ nbfcId: string }>;
}) {
  const { nbfcId } = use(params);
  const id = Number.parseInt(nbfcId, 10);

  if (!Number.isInteger(id) || id <= 0) {
    return (
      <PageShell title="NBFC Review" subtitle={`Invalid NBFC id: ${nbfcId}`}>
        <div
          className="card-iTarang p-6 text-sm"
          style={{ color: "var(--color-danger)" }}
        >
          The NBFC id in the URL is not a valid integer.
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      eyebrow="Review"
      title={`NBFC Review #${nbfcId}`}
      subtitle="Confirm compliance documents and the LSP agreement before CEO sign-off."
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "NBFC", href: "/admin/nbfc" },
        { label: nbfcId },
        { label: "Review" },
      ]}
      steps={buildNbfcSteps({
        active: "approval",
        done: ["master", "documents", "lsp"],
      })}
    >
      <NbfcFinalApprovalPanel nbfcId={id} />
    </PageShell>
  );
}
