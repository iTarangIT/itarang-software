"use client";

/**
 * E-001 — NBFC final approval panel.
 *
 * Reads /api/admin/nbfc/{nbfcId}/approval-readiness on mount and renders an
 * Approve button. Button is disabled (with the BRD-mandated tooltip) when
 * canApprove=false. Clicking Approve POSTs to /api/admin/nbfc/{nbfcId}/approve.
 */
import { useCallback, useEffect, useState } from "react";

export type ReadinessPayload = {
  canApprove: boolean;
  missingDocs: string[];
  lspAgreementStatus: string;
  reason: string | null;
};

type Props = {
  nbfcId: number;
  /**
   * Optional override fetcher — primarily for tests. Defaults to fetch().
   */
  fetcher?: typeof fetch;
};

const TOOLTIP_NOT_READY =
  "Cannot activate until LSP Agreement is fully signed and downloaded from Digio.";

export default function NbfcFinalApprovalPanel({ nbfcId, fetcher }: Props) {
  const fx = fetcher ?? fetch;
  const [readiness, setReadiness] = useState<ReadinessPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [approvedAt, setApprovedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fx(`/api/admin/nbfc/${nbfcId}/approval-readiness`, {
        method: "GET",
        headers: { "content-type": "application/json" },
      });
      const body = (await res.json()) as ReadinessPayload;
      setReadiness(body);
    } finally {
      setLoading(false);
    }
  }, [fx, nbfcId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onApprove = useCallback(async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fx(`/api/admin/nbfc/${nbfcId}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setSubmitError(
          (err as { reason?: string; error?: string }).reason ??
            (err as { error?: string }).error ??
            `Approval failed (${res.status})`,
        );
        return;
      }
      const body = (await res.json()) as { approvedAt: string };
      setApprovedAt(body.approvedAt);
      await refresh();
    } finally {
      setSubmitting(false);
    }
  }, [fx, nbfcId, refresh]);

  const disabled = !readiness?.canApprove || submitting || loading;
  // Per BRD §6.0.2: tooltip ONLY shows when not ready (button disabled for
  // that reason). When the gate is open and we just disable for the
  // submitting spinner, no tooltip.
  const tooltip =
    readiness && !readiness.canApprove ? TOOLTIP_NOT_READY : undefined;

  return (
    <section
      data-testid="nbfc-final-approval-panel"
      className="rounded-md border bg-white p-4"
    >
      <h2 className="mb-2 text-lg font-semibold">Final Approval</h2>

      {loading ? (
        <p className="text-sm text-gray-500">Loading readiness…</p>
      ) : readiness ? (
        <div className="space-y-2 text-sm">
          <div>
            LSP Agreement Status:{" "}
            <span data-testid="lsp-agreement-status">
              {readiness.lspAgreementStatus}
            </span>
          </div>
          {readiness.missingDocs.length > 0 && (
            <div data-testid="missing-docs">
              Missing verified documents: {readiness.missingDocs.join(", ")}
            </div>
          )}
          {readiness.reason && (
            <div className="text-amber-700" data-testid="reason">
              {readiness.reason}
            </div>
          )}
        </div>
      ) : null}

      <div className="mt-4">
        <button
          type="button"
          data-testid="approve-button"
          aria-disabled={disabled}
          disabled={disabled}
          title={tooltip}
          onClick={() => void onApprove()}
          className={
            "rounded-md px-4 py-2 text-white " +
            (disabled
              ? "cursor-not-allowed bg-gray-300"
              : "bg-emerald-600 hover:bg-emerald-700")
          }
        >
          {submitting ? "Approving…" : "Approve & Activate NBFC"}
        </button>
        {submitError && (
          <p data-testid="submit-error" className="mt-2 text-sm text-red-600">
            {submitError}
          </p>
        )}
        {approvedAt && (
          <p data-testid="approved-at" className="mt-2 text-sm text-emerald-700">
            Approved at {approvedAt}
          </p>
        )}
      </div>
    </section>
  );
}
