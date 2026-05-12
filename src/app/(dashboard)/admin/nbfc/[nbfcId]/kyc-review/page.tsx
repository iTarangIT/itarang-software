"use client";

import { use } from "react";
import NbfcKycReviewPanel from "@/components/admin/nbfc/NbfcKycReviewPanel";
import { PageShell, buildNbfcSteps } from "@/components/layout/PageShell";

export default function NbfcKycReviewPage({
  params,
}: {
  params: Promise<{ nbfcId: string }>;
}) {
  const { nbfcId } = use(params);
  const id = Number.parseInt(nbfcId, 10);

  if (!Number.isInteger(id) || id <= 0) {
    return (
      <PageShell title="NBFC KYC Review" subtitle={`Invalid NBFC id: ${nbfcId}`}>
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
      eyebrow="KYC Review"
      title={`NBFC KYC #${nbfcId}`}
      subtitle="Run CIN, PAN, GSTIN against the entity and PAN, Aadhaar, RC against the director before opening the final approval gate."
      breadcrumb={[
        { label: "Admin", href: "/admin" },
        { label: "NBFC", href: "/admin/nbfc" },
        { label: nbfcId },
        { label: "KYC Review" },
      ]}
      steps={buildNbfcSteps({
        active: "approval",
        done: ["master", "documents", "lsp"],
      })}
    >
      <NbfcKycReviewPanel nbfcId={id} />
    </PageShell>
  );
}
