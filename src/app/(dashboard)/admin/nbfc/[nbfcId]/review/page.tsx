"use client";

import { use } from "react";
import NbfcFinalApprovalPanel from "@/components/admin/nbfc/NbfcFinalApprovalPanel";

/**
 * E-001 — Admin review page for an NBFC. Currently surfaces only the final
 * approval gate; siblings will add document and LSP-agreement panels.
 */
export default function NbfcReviewPage({
  params,
}: {
  params: Promise<{ nbfcId: string }>;
}) {
  const { nbfcId } = use(params);
  const id = Number.parseInt(nbfcId, 10);
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">NBFC Review #{nbfcId}</h1>
      {Number.isInteger(id) ? (
        <NbfcFinalApprovalPanel nbfcId={id} />
      ) : (
        <p className="text-red-600">Invalid NBFC id</p>
      )}
    </div>
  );
}
