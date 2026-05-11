"use client";

/**
 * E-002 — NBFC activation button.
 *
 * Renders below the final-approval panel. Button is enabled only when the
 * NBFC has been approved (status='approved') and not yet activated. Clicking
 * Activate POSTs to /api/admin/nbfc/{nbfcId}/activate; on success we surface
 * the masked email address the credentials were dispatched to. A small
 * 'Resend credentials' affordance reissues a fresh password (status remains
 * 'active'; a new nbfc_portal_credentials row is appended).
 */
import { useCallback, useState } from "react";

type Props = {
  nbfcId: number;
  initialStatus?: string;
  fetcher?: typeof fetch;
};

export default function NbfcActivationButton({
  nbfcId,
  initialStatus,
  fetcher,
}: Props) {
  const fx = fetcher ?? fetch;
  const [status, setStatus] = useState<string | undefined>(initialStatus);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dispatchedTo, setDispatchedTo] = useState<string | null>(null);

  const activate = useCallback(
    async (resend = false) => {
      setSubmitting(true);
      setError(null);
      try {
        const res = await fx(`/api/admin/nbfc/${nbfcId}/activate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resend }),
        });
        const j = (await res.json()) as {
          ok?: boolean;
          status?: string;
          credentialDispatchedTo?: string;
          error?: string;
          message?: string;
        };
        if (!res.ok || !j.ok) {
          setError(j.message ?? j.error ?? `HTTP ${res.status}`);
          return;
        }
        setStatus(j.status ?? "active");
        setDispatchedTo(j.credentialDispatchedTo ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setSubmitting(false);
      }
    },
    [fx, nbfcId],
  );

  const isActive = status === "active";
  const canActivate = status === "approved";

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="text-sm font-medium">Portal credentials</div>
      {!canActivate && !isActive && (
        <p className="text-xs text-muted-foreground">
          NBFC must be approved before portal credentials can be issued.
        </p>
      )}
      {isActive && dispatchedTo && (
        <p className="text-xs text-green-700">
          Credentials dispatched to <span className="font-mono">{dispatchedTo}</span>.
        </p>
      )}
      {error && (
        <p className="text-xs text-red-700" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!canActivate || submitting}
          onClick={() => void activate(false)}
          className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-50"
        >
          {submitting ? "Activating..." : "Activate"}
        </button>
        {isActive && (
          <button
            type="button"
            disabled={submitting}
            onClick={() => void activate(true)}
            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
          >
            {submitting ? "Sending..." : "Resend credentials"}
          </button>
        )}
      </div>
    </div>
  );
}
