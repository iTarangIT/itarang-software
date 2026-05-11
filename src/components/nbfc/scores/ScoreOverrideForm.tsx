/**
 * E-093 — ScoreOverrideForm
 *
 * Risk-Manager-only form to override a borrower's computed credit score with a
 * documented reason. Submits to POST /api/nbfc/scores/override. The override
 * does not mutate the computed score — the form makes that promise explicit
 * to the user.
 */
"use client";
import { useState, type FormEvent } from "react";

export interface ScoreOverrideFormProps {
  loanApplicationId: string;
  scoreType: "cds" | "pci";
  computedScoreValue: number;
  onSuccess?: (override: {
    id: string;
    override_value: number;
    reason: string;
  }) => void;
}

export function ScoreOverrideForm({
  loanApplicationId,
  scoreType,
  computedScoreValue,
  onSuccess,
}: ScoreOverrideFormProps) {
  const [overrideValue, setOverrideValue] = useState<number>(
    computedScoreValue,
  );
  const [reason, setReason] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (reason.length < 20) {
      setError("Reason must be at least 20 characters.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/nbfc/scores/override", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          loan_application_id: loanApplicationId,
          score_type: scoreType,
          override_value: overrideValue,
          reason,
          computed_score_value: computedScoreValue,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      onSuccess?.({
        id: data.id,
        override_value: data.override_value,
        reason: data.reason,
      });
      setReason("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="text-sm text-gray-600">
        Computed {scoreType.toUpperCase()} score:{" "}
        <span className="font-mono">{computedScoreValue.toFixed(2)}</span>
        <span className="ml-2 text-xs italic">
          (override is logged for audit; does not change the computed score)
        </span>
      </div>
      <label className="block">
        <span className="text-sm font-medium">Override value</span>
        <input
          type="number"
          min={0}
          max={100}
          step={0.01}
          value={overrideValue}
          onChange={(e) => setOverrideValue(Number(e.target.value))}
          className="mt-1 w-full rounded border px-2 py-1"
          required
        />
      </label>
      <label className="block">
        <span className="text-sm font-medium">
          Documented reason{" "}
          <span className="text-xs text-gray-500">
            (≥ 20 chars, required by RBI Digital Lending Directions 2025)
          </span>
        </span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          minLength={20}
          maxLength={1000}
          rows={3}
          className="mt-1 w-full rounded border px-2 py-1"
          required
        />
        <span className="text-xs text-gray-500">{reason.length}/1000</span>
      </label>
      {error && <div className="text-sm text-red-600">{error}</div>}
      <button
        type="submit"
        disabled={submitting}
        className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50"
      >
        {submitting ? "Submitting…" : "Override score"}
      </button>
    </form>
  );
}

export default ScoreOverrideForm;
