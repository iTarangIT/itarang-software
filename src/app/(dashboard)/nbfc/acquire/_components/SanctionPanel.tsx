"use client";

/**
 * Sanction / Disburse — Addendum V0.2 §6.1 / §7.4. Shown to the WINNING NBFC.
 *
 * 23 Nov 2026 — two separate statuses / actions (they were one click):
 *  - mode "sanction" (E-NACH & Agreement step): gated on the unified
 *    verification-track gate (E-NACH hard gate §9.4, FI + VKYC when the Track
 *    Rules completion gate is on). Writes the loan as 'sanctioned' and opens the
 *    dealer's Step 5 (OTP + dispatch).
 *  - mode "disburse" (last step, card + button "Disburse"): marks the sanctioned
 *    loan 'disbursed', fires the on_disbursal wallet charge and the disbursement
 *    notices.
 * Owned by Credit / Underwriting.
 */
import { useCallback, useEffect, useState } from "react";
import { confirmDialog } from "@/components/ui/confirm-dialog";

type TrackKey = "fi" | "vkyc" | "enach";
type TrackState = { key: TrackKey; required: boolean; status: string | null; complete: boolean; failed: boolean };
type TrackGate = {
  satisfied: boolean;
  reason: string;
  completion_gate: boolean;
  failure_halts: boolean;
  blocked_by_failure: boolean;
  tracks: TrackState[];
};
type AgreementGate = {
  applicable: boolean;
  satisfied: boolean;
  status: string | null;
  method: string | null;
  reason: string;
};
type Loan = {
  id: string;
  status: string;
  loan_amount: string | null;
  emi: string | null;
  tenure_months: number | null;
  sanctioned_at: string | null;
  disbursed_at: string | null;
  disbursement_amount: string | null;
  reference: string | null;
};
type Resp = {
  ok: boolean;
  is_winner?: boolean;
  already_sanctioned?: boolean;
  already_disbursed?: boolean;
  track_gate?: TrackGate;
  agreement_gate?: AgreementGate;
  can_sanction?: boolean;
  can_disburse?: boolean;
  loan?: Loan | null;
  lead_status?: string | null;
  error?: string;
};

const TRACK_LABEL: Record<TrackKey, string> = {
  fi: "Field Investigation",
  vkyc: "Video KYC",
  enach: "E-NACH",
};

function inr(v: string | number | null | undefined) {
  if (v == null || v === "") return "—";
  const n = Number(v);
  return Number.isFinite(n) ? `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}` : "—";
}
function when(ts: string | null | undefined) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function SanctionPanel({ leadId, mode = "sanction" }: { leadId: string; mode?: "sanction" | "disburse" }) {
  const [data, setData] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/nbfc/sanction/${leadId}`);
      setData((await res.json()) as Resp);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: "sanction" | "disburse") {
    const ok = await confirmDialog(
      action === "sanction"
        ? {
            title: "Sanction this loan?",
            message: "The loan is recorded as sanctioned and the dealer can start Step 5 (OTP + dispatch). Disbursement is a separate step.",
            confirmText: "Sanction",
            variant: "danger",
          }
        : {
            title: "Disburse this loan?",
            message: "The loan is recorded as disbursed, your wallet is charged per the disbursal rule and the dealer is notified.",
            confirmText: "Disburse",
            variant: "danger",
          },
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/sanction/${leadId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          action === "sanction"
            ? { action }
            : { action, amount: amount.trim() || null, reference: reference.trim() || null },
        ),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      await load();
      // The server page derives the stepper from the same rows.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^(BAD_REQUEST|FORBIDDEN): /, "") : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Only the winning NBFC sees this panel.
  if (!data || data.is_winner === false) return null;

  const sanctioned = !!data.already_sanctioned;
  const disbursed = !!data.already_disbursed;
  const loan = data.loan ?? null;

  if (mode === "disburse") {
    return (
      <section className="border border-slate-200 rounded-xl bg-white p-5">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-3">Disburse</h2>
        {error && <p className="text-[11px] text-red-600 mb-2">{error}</p>}
        {disbursed ? (
          <div className="space-y-1 text-xs">
            <p className="text-emerald-700 font-semibold">Disbursed on {when(loan?.disbursed_at)}.</p>
            <p className="text-slate-600">
              Amount {inr(loan?.disbursement_amount ?? loan?.loan_amount)}
              {loan?.reference ? ` · Ref ${loan.reference}` : ""}
            </p>
          </div>
        ) : !sanctioned || !loan ? (
          <p className="text-xs text-slate-500">
            Sanction the loan first in the <b>E-NACH &amp; Agreement</b> step. Disburse unlocks once it is sanctioned.
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-600">
              Sanctioned on {when(loan.sanctioned_at)} · {inr(loan.loan_amount)}
              {loan.emi ? ` · EMI ${inr(loan.emi)}` : ""}
              {loan.tenure_months ? ` × ${loan.tenure_months} months` : ""}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <label className="text-[11px] text-slate-500">
                Disbursed amount (₹)
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
                  placeholder={loan.loan_amount ? String(Number(loan.loan_amount)) : "Loan amount"}
                  className="mt-1 w-full border border-slate-200 rounded px-2 py-1.5 text-sm text-slate-800"
                  inputMode="decimal"
                />
              </label>
              <label className="text-[11px] text-slate-500">
                Reference / UTR (optional)
                <input
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  maxLength={64}
                  className="mt-1 w-full border border-slate-200 rounded px-2 py-1.5 text-sm text-slate-800"
                />
              </label>
            </div>
            <button
              onClick={() => act("disburse")}
              disabled={busy || !data.can_disburse}
              className="px-4 py-2 rounded-md bg-emerald-600 text-white text-xs font-bold disabled:opacity-50"
            >
              {busy ? "Disbursing…" : "Disburse"}
            </button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="border border-slate-200 rounded-xl bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-3">Sanction</h2>

      {error && <p className="text-[11px] text-red-600 mb-2">{error}</p>}

      {sanctioned ? (
        <p className="text-xs text-emerald-700 font-semibold">
          Loan sanctioned{loan?.sanctioned_at ? ` on ${when(loan.sanctioned_at)}` : ""}. The dealer can now complete Step 5 (OTP + dispatch).
          {disbursed ? " Disbursed." : " Disburse it from the last step once the money is released."}
        </p>
      ) : (
        <>
          {data.track_gate && (
            <div className="mb-3 space-y-1.5">
              {data.track_gate.tracks.filter((t) => t.required).length === 0 ? (
                <p className="text-[11px] text-slate-500">No iTarang verification tracks apply to this lead.</p>
              ) : (
                data.track_gate.tracks
                  .filter((t) => t.required)
                  .map((t) => {
                    const tone = t.complete ? "text-emerald-700" : t.failed ? "text-red-600" : "text-amber-700";
                    const mark = t.complete ? "✓" : t.failed ? "✕" : "•";
                    return (
                      <p key={t.key} className={`text-[11px] ${tone}`}>
                        <span className="font-mono mr-1.5">{mark}</span>
                        {TRACK_LABEL[t.key]}: {t.complete ? "complete" : t.failed ? "failed" : (t.status ?? "pending")}
                      </p>
                    );
                  })
              )}
              {data.agreement_gate?.applicable && (() => {
                const ag = data.agreement_gate!;
                const signed = ag.status === "signed";
                const skipped = ag.status === "skipped";
                const tone = signed || skipped ? "text-emerald-700" : "text-slate-500";
                const mark = signed || skipped ? "✓" : "•";
                const label = signed ? "signed" : skipped ? "not required" : (ag.status ?? "pending");
                return (
                  <p className={`text-[11px] ${tone}`}>
                    <span className="font-mono mr-1.5">{mark}</span>
                    Loan Agreement: {label}
                    <span className="text-slate-400"> · advisory (Step-5 OTP is the gate)</span>
                  </p>
                );
              })()}
              {!data.track_gate.satisfied && (
                <p className="text-[11px] text-amber-700 pt-1">{data.track_gate.reason}</p>
              )}
            </div>
          )}
          <button
            onClick={() => act("sanction")}
            disabled={busy || !data.can_sanction}
            className="px-4 py-2 rounded-md bg-emerald-600 text-white text-xs font-bold disabled:opacity-50"
          >
            {busy ? "Sanctioning…" : "Sanction loan"}
          </button>
          {!data.can_sanction && data.track_gate && !data.track_gate.satisfied && (
            <p className="text-[11px] text-slate-400 mt-2">Complete the verification tracks above to enable the sanction.</p>
          )}
        </>
      )}
    </section>
  );
}
