"use client";

/**
 * Sanction & Disburse — Addendum V0.2 §6.1 / §7.4. Shown to the WINNING NBFC
 * once the customer has selected it. Gated on the unified verification-track
 * gate: E-NACH is a hard gate (§9.4), and FI + VKYC must also complete when the
 * NBFC's Track Rules completion gate is on. Sanctioning writes the loan,
 * advances the lead to Step 5, and fires the on_disbursal wallet charge. Owned
 * by Credit / Underwriting.
 */
import { useCallback, useEffect, useState } from "react";

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
type Resp = {
  ok: boolean;
  is_winner?: boolean;
  already_sanctioned?: boolean;
  track_gate?: TrackGate;
  agreement_gate?: AgreementGate;
  can_sanction?: boolean;
  lead_status?: string | null;
  error?: string;
};

const TRACK_LABEL: Record<TrackKey, string> = {
  fi: "Field Investigation",
  vkyc: "Video KYC",
  enach: "E-NACH",
};

export default function SanctionPanel({ leadId }: { leadId: string }) {
  const [data, setData] = useState<Resp | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function sanction() {
    if (!confirm("Sanction & disburse this loan? This advances the lead to dispatch (Step 5) and charges your wallet per the disbursal rule.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/nbfc/sanction/${leadId}`, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Only the winning NBFC sees this panel.
  if (!data || data.is_winner === false) return null;

  const sanctioned = data.already_sanctioned || data.lead_status === "loan_sanctioned" || data.lead_status === "sold";

  return (
    <section className="border border-slate-200 rounded-xl bg-white p-5">
      <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-3">Sanction & Disburse</h2>

      {error && <p className="text-[11px] text-red-600 mb-2">{error}</p>}

      {sanctioned ? (
        <p className="text-xs text-emerald-700 font-semibold">
          Loan sanctioned. The dealer can now complete Step 5 (OTP + dispatch).
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
            onClick={sanction}
            disabled={busy || !data.can_sanction}
            className="px-4 py-2 rounded-md bg-emerald-600 text-white text-xs font-bold disabled:opacity-50"
          >
            {busy ? "Sanctioning…" : "Sanction & Disburse"}
          </button>
          {!data.can_sanction && data.track_gate && !data.track_gate.satisfied && (
            <p className="text-[11px] text-slate-400 mt-2">Complete the verification tracks above to enable disbursal.</p>
          )}
        </>
      )}
    </section>
  );
}
