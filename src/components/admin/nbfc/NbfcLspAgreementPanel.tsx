"use client";

/**
 * NbfcLspAgreementPanel — E-007 LSP agreement initiation.
 *
 * Visual: BRD §6.B. Three numbered signer cards rendered in sequential
 * cadence (NBFC → iTarang Signatory 1 → iTarang Signatory 2). The layout
 * makes the order of signing legible at a glance.
 *
 * Test contract — every existing data-testid is preserved verbatim:
 *   lsp-agreement-form, nbfc-signatory-{name,email}, itarang{1,2}-{name,email},
 *   initiate-button, initiate-result, initiate-error.
 */
import { useState, type FormEvent } from "react";
import { Loader2, CheckCircle2, AlertCircle } from "lucide-react";

interface InitiateResult {
  ok?: boolean;
  id?: number;
  agreementId?: string;
  digioDocumentId?: string;
  agreementStatus?: string;
  expiresAt?: string | null;
  error?: string;
  message?: string;
}

const initialForm = {
  nbfcSignatoryName: "",
  nbfcSignatoryEmail: "",
  itarangSignatory1Name: "",
  itarangSignatory1Email: "",
  itarangSignatory2Name: "",
  itarangSignatory2Email: "",
};

interface SignerCardProps {
  step: 1 | 2 | 3;
  eyebrow: string;
  title: string;
  nameTestId: string;
  emailTestId: string;
  nameValue: string;
  emailValue: string;
  onNameChange: (v: string) => void;
  onEmailChange: (v: string) => void;
}

function SignerCard({
  step,
  eyebrow,
  title,
  nameTestId,
  emailTestId,
  nameValue,
  emailValue,
  onNameChange,
  onEmailChange,
}: SignerCardProps) {
  return (
    <div className="card-iTarang p-5 md:p-6 relative">
      <div className="flex items-center gap-3 mb-4">
        <div className="step-dot-active text-base">{step}</div>
        <div>
          <p className="section-label">{eyebrow}</p>
          <h3 className="text-base font-semibold text-[color:var(--color-brand-navy)]">
            {title}
          </h3>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-[color:var(--color-ink)]">
            Full name
          </span>
          <input
            type="text"
            required
            value={nameValue}
            onChange={(e) => onNameChange(e.target.value)}
            className="input-itarang"
            data-testid={nameTestId}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs font-semibold text-[color:var(--color-ink)]">
            Email
          </span>
          <input
            type="email"
            required
            value={emailValue}
            onChange={(e) => onEmailChange(e.target.value)}
            className="input-itarang"
            data-testid={emailTestId}
          />
        </label>
      </div>
    </div>
  );
}

export default function NbfcLspAgreementPanel({
  nbfcId,
}: {
  nbfcId: number;
}) {
  const [form, setForm] = useState(initialForm);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<InitiateResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch(
        `/api/admin/nbfc/${nbfcId}/lsp-agreement/initiate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        },
      );
      const body = (await res.json()) as InitiateResult;
      if (!res.ok || body.ok === false) {
        setError(body.message ?? body.error ?? "Initiation failed");
        return;
      }
      setResult(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="section-label">LSP Agreement</p>
        <h2 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">
          Sequential signing via Digio
        </h2>
        <p className="text-sm text-[color:var(--color-ink-muted)] mt-1 max-w-2xl">
          Signers are notified in order — NBFC first, then iTarang's two
          authorised signatories. The agreement is fully signed when all three
          have completed Digio's request and the document is downloaded.
        </p>
      </div>

      <form
        onSubmit={onSubmit}
        className="space-y-4"
        data-testid="lsp-agreement-form"
      >
        <SignerCard
          step={1}
          eyebrow="Signer 1 of 3"
          title="NBFC Authorised Signatory"
          nameTestId="nbfc-signatory-name"
          emailTestId="nbfc-signatory-email"
          nameValue={form.nbfcSignatoryName}
          emailValue={form.nbfcSignatoryEmail}
          onNameChange={(v) =>
            setForm((f) => ({ ...f, nbfcSignatoryName: v }))
          }
          onEmailChange={(v) =>
            setForm((f) => ({ ...f, nbfcSignatoryEmail: v }))
          }
        />
        <SignerCard
          step={2}
          eyebrow="Signer 2 of 3"
          title="iTarang Signatory 1"
          nameTestId="itarang1-name"
          emailTestId="itarang1-email"
          nameValue={form.itarangSignatory1Name}
          emailValue={form.itarangSignatory1Email}
          onNameChange={(v) =>
            setForm((f) => ({ ...f, itarangSignatory1Name: v }))
          }
          onEmailChange={(v) =>
            setForm((f) => ({ ...f, itarangSignatory1Email: v }))
          }
        />
        <SignerCard
          step={3}
          eyebrow="Signer 3 of 3"
          title="iTarang Signatory 2"
          nameTestId="itarang2-name"
          emailTestId="itarang2-email"
          nameValue={form.itarangSignatory2Name}
          emailValue={form.itarangSignatory2Email}
          onNameChange={(v) =>
            setForm((f) => ({ ...f, itarangSignatory2Name: v }))
          }
          onEmailChange={(v) =>
            setForm((f) => ({ ...f, itarangSignatory2Email: v }))
          }
        />

        <div className="flex justify-end pt-2">
          <button
            type="submit"
            disabled={submitting}
            className="btn-primary"
            data-testid="initiate-button"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            {submitting ? "Initiating…" : "Initiate Agreement"}
          </button>
        </div>
      </form>

      {error && (
        <div
          role="alert"
          data-testid="initiate-error"
          className="flex items-start gap-3 rounded-xl px-4 py-3 border"
          style={{
            background: "var(--color-danger-bg)",
            borderColor: "rgba(192, 57, 43, 0.3)",
            color: "var(--color-danger)",
          }}
        >
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="text-sm">
            <p className="font-semibold">Couldn't initiate agreement</p>
            <p className="opacity-90">{error}</p>
          </div>
        </div>
      )}

      {result?.ok && (
        <div
          data-testid="initiate-result"
          className="card-iTarang p-5"
          style={{ borderColor: "rgba(30,126,52,0.25)" }}
        >
          <div className="flex items-start gap-3">
            <CheckCircle2
              className="w-5 h-5 shrink-0 mt-0.5"
              style={{ color: "var(--color-success)" }}
            />
            <div className="flex-1 space-y-2">
              <p className="font-semibold text-[color:var(--color-brand-navy)]">
                Sent to NBFC for signing
              </p>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <Row label="Agreement ID" mono value={result.agreementId} />
                <Row
                  label="Digio Document ID"
                  mono
                  value={result.digioDocumentId}
                />
                <Row label="Status" value={result.agreementStatus} />
                <Row label="Expires at" value={result.expiresAt ?? undefined} />
              </dl>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value?: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="section-label-muted text-[10px]">{label}</dt>
      <dd
        className={`mt-0.5 text-[color:var(--color-brand-navy)] ${
          mono ? "font-mono text-[13px]" : ""
        }`}
      >
        {value ?? "—"}
      </dd>
    </div>
  );
}
