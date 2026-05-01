"use client";

/**
 * E-007 — NBFC LSP Agreement initiation panel.
 *
 * Six required signatory fields (NBFC + iTarang1 + iTarang2). Submitting POSTs
 * to /api/admin/nbfc/{nbfcId}/lsp-agreement/initiate. Returns the persisted
 * row summary on success.
 */
import { useState, type FormEvent } from "react";

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

export default function NbfcLspAgreementPanel({ nbfcId }: { nbfcId: number }) {
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
    <div className="max-w-2xl space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Initiate LSP Agreement</h1>
        <p className="text-sm text-muted-foreground">
          Sequential signing order: NBFC Signatory → iTarang Signatory 1 → iTarang Signatory 2.
        </p>
      </header>

      <form
        onSubmit={onSubmit}
        className="space-y-4"
        data-testid="lsp-agreement-form"
      >
        <fieldset className="rounded-md border p-4">
          <legend className="px-2 text-sm font-medium">NBFC Signatory</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm">Name</span>
              <input
                type="text"
                required
                value={form.nbfcSignatoryName}
                onChange={(e) =>
                  setForm((f) => ({ ...f, nbfcSignatoryName: e.target.value }))
                }
                className="mt-1 w-full rounded border px-3 py-2"
                data-testid="nbfc-signatory-name"
              />
            </label>
            <label className="block">
              <span className="text-sm">Email</span>
              <input
                type="email"
                required
                value={form.nbfcSignatoryEmail}
                onChange={(e) =>
                  setForm((f) => ({ ...f, nbfcSignatoryEmail: e.target.value }))
                }
                className="mt-1 w-full rounded border px-3 py-2"
                data-testid="nbfc-signatory-email"
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="rounded-md border p-4">
          <legend className="px-2 text-sm font-medium">iTarang Signatory 1</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm">Name</span>
              <input
                type="text"
                required
                value={form.itarangSignatory1Name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, itarangSignatory1Name: e.target.value }))
                }
                className="mt-1 w-full rounded border px-3 py-2"
                data-testid="itarang1-name"
              />
            </label>
            <label className="block">
              <span className="text-sm">Email</span>
              <input
                type="email"
                required
                value={form.itarangSignatory1Email}
                onChange={(e) =>
                  setForm((f) => ({ ...f, itarangSignatory1Email: e.target.value }))
                }
                className="mt-1 w-full rounded border px-3 py-2"
                data-testid="itarang1-email"
              />
            </label>
          </div>
        </fieldset>

        <fieldset className="rounded-md border p-4">
          <legend className="px-2 text-sm font-medium">iTarang Signatory 2</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-sm">Name</span>
              <input
                type="text"
                required
                value={form.itarangSignatory2Name}
                onChange={(e) =>
                  setForm((f) => ({ ...f, itarangSignatory2Name: e.target.value }))
                }
                className="mt-1 w-full rounded border px-3 py-2"
                data-testid="itarang2-name"
              />
            </label>
            <label className="block">
              <span className="text-sm">Email</span>
              <input
                type="email"
                required
                value={form.itarangSignatory2Email}
                onChange={(e) =>
                  setForm((f) => ({ ...f, itarangSignatory2Email: e.target.value }))
                }
                className="mt-1 w-full rounded border px-3 py-2"
                data-testid="itarang2-email"
              />
            </label>
          </div>
        </fieldset>

        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
          data-testid="initiate-button"
        >
          {submitting ? "Initiating…" : "Initiate Agreement"}
        </button>
      </form>

      {error && (
        <div
          className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800"
          data-testid="initiate-error"
        >
          {error}
        </div>
      )}

      {result?.ok && (
        <div
          className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800"
          data-testid="initiate-result"
        >
          <div>
            <strong>Agreement ID:</strong> {result.agreementId}
          </div>
          <div>
            <strong>Digio Document ID:</strong> {result.digioDocumentId}
          </div>
          <div>
            <strong>Status:</strong> {result.agreementStatus}
          </div>
          <div>
            <strong>Expires At:</strong> {result.expiresAt}
          </div>
        </div>
      )}
    </div>
  );
}
