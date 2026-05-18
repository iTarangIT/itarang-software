"use client";

/**
 * E-002 — NBFC activation button.
 *
 * Mounted on /admin/nbfc/[id]/review for non-CEO viewers once Digio reports
 * the agreement as COMPLETED. Admin clicks "Activate Account" → POST
 * /api/admin/nbfc/{nbfcId}/activate provisions the Supabase user, creates
 * the tenant, dispatches credential email, flips status to 'active'. The
 * "Resend credentials" affordance reissues a fresh password once active.
 */
import { useCallback, useState } from "react";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";

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
  const router = useRouter();
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
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Unknown error");
      } finally {
        setSubmitting(false);
      }
    },
    [fx, nbfcId, router],
  );

  const isActive = status === "active";
  const canActivate = status === "approved";

  return (
    <section
      data-testid="nbfc-activation-card"
      className="card-iTarang p-5 space-y-3"
    >
      <header className="flex items-start gap-3">
        <ShieldCheck
          className="w-5 h-5 mt-0.5 shrink-0"
          style={{ color: "var(--color-brand-sky)" }}
        />
        <div>
          <p className="section-label-muted">Activation</p>
          <h3 className="text-base font-semibold text-[color:var(--color-brand-navy)] mt-0.5">
            Issue portal credentials
          </h3>
          <p className="text-[13px] text-[color:var(--color-ink-muted)] mt-1 max-w-2xl">
            Generates a one-time password, provisions the NBFC&apos;s tenant,
            and emails sign-in instructions to the primary contact. The NBFC
            portal becomes accessible only after this step.
          </p>
        </div>
      </header>

      {isActive && dispatchedTo && (
        <div
          className="flex items-start gap-2 rounded-xl px-3 py-2 text-[13px]"
          style={{
            background: "var(--color-success-bg)",
            color: "var(--color-success)",
          }}
        >
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Credentials dispatched to{" "}
            <span className="font-mono">{dispatchedTo}</span>.
          </span>
        </div>
      )}

      {error && (
        <p
          data-testid="activation-error"
          role="alert"
          className="text-[13px] rounded-xl px-3 py-2"
          style={{
            background: "var(--color-danger-bg)",
            color: "var(--color-danger)",
          }}
        >
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          data-testid="activate-account-button"
          disabled={!canActivate || submitting}
          onClick={() => void activate(false)}
          className={
            !canActivate || submitting
              ? "inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl text-sm font-semibold cursor-not-allowed bg-[color:var(--color-brand-silver)] text-white opacity-70"
              : "btn-primary inline-flex items-center justify-center gap-2"
          }
        >
          {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
          {isActive ? "Account active" : submitting ? "Activating…" : "Activate Account"}
        </button>
        {isActive && (
          <button
            type="button"
            data-testid="resend-credentials-button"
            disabled={submitting}
            onClick={() => void activate(true)}
            className="inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl text-sm font-semibold border border-[color:var(--color-brand-sky)] text-[color:var(--color-brand-sky)] hover:bg-[color:var(--color-brand-sky)]/10 transition-colors disabled:opacity-50"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {submitting ? "Sending…" : "Resend credentials"}
          </button>
        )}
      </div>
    </section>
  );
}
