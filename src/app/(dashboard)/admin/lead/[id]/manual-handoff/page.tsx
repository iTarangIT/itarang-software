"use client";

/**
 * Admin Manual Handoff (Model M2) — BRD Addendum V0.2 §11.7. Send the customer
 * KYC to off-platform NBFC email(s), track Sent→Outcome, and record the
 * outcome. On acceptance the lead re-enters for disbursement + Step 5.
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Handoff = {
  status: string;
  sent_to_emails: Array<{ email: string; nbfc_name?: string }>;
  sent_at: string;
  last_nudge_at: string | null;
  nudge_count: number;
  outcome: string | null;
  winning_nbfc_name: string | null;
  outcome_recorded_at: string | null;
};

const BADGE: Record<string, string> = {
  sent: "bg-amber-100 text-amber-700",
  outcome_accepted: "bg-emerald-100 text-emerald-700",
  outcome_declined: "bg-red-100 text-red-700",
  exhausted: "bg-slate-200 text-slate-600",
};

export default function ManualHandoffPage() {
  const { id: leadId } = useParams<{ id: string }>();
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [rows, setRows] = useState<Array<{ email: string; nbfc_name: string }>>([{ email: "", nbfc_name: "" }]);
  const [winner, setWinner] = useState("");
  const [outcomeNote, setOutcomeNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deadEndCategory, setDeadEndCategory] = useState<"all_declined" | "no_match" | "handoff_unanswered">("all_declined");
  const [deadEndDone, setDeadEndDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/lead/${leadId}/manual-handoff`);
      const j = (await res.json()) as { ok: boolean; handoff: Handoff | null; error?: string };
      if (!j.ok) throw new Error(j.error ?? "Failed");
      setHandoff(j.handoff);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [leadId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function call(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/lead/${leadId}/manual-handoff${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { message?: string } };
      if (!res.ok || j.success === false) throw new Error(j.error?.message ?? `HTTP ${res.status}`);
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function markFinancingUnavailable() {
    if (
      !confirm(
        "Confirm this lead's financing is UNAVAILABLE? This is terminal — finance-only sensitive data (bureau report, co-borrower KYC, NBFC offers) will be purged. The dealer can still convert it to a cash sale.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/lead/${leadId}/financing-unavailable`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category: deadEndCategory, notes: outcomeNote || undefined }),
      });
      const j = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { message?: string } };
      if (!res.ok || j.success === false) throw new Error(j.error?.message ?? `HTTP ${res.status}`);
      setDeadEndDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const emails = rows
      .filter((r) => r.email.trim())
      .map((r) => ({ email: r.email.trim(), nbfc_name: r.nbfc_name.trim() || undefined }));
    if (emails.length === 0) {
      setError("Add at least one NBFC email.");
      return;
    }
    await call("/send", { emails });
  }

  return (
    <div className="px-6 py-8 space-y-6 max-w-3xl mx-auto">
      <header>
        <p className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">Manual Handoff · Model M2</p>
        <h1 className="text-2xl font-semibold text-[color:var(--color-brand-navy)] mt-1">Lead {leadId}</h1>
        <p className="text-sm text-slate-500 mt-1">
          Route this lead to off-platform NBFC(s) by email. Competitive — multiple may approve; the customer picks the winner.
        </p>
      </header>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {handoff && (
        <section className="border border-slate-200 rounded-xl bg-white p-5 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">Current handoff</h2>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${BADGE[handoff.status] ?? "bg-slate-100 text-slate-500"}`}>
              {handoff.status.replace(/_/g, " ")}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            Sent {new Date(handoff.sent_at).toLocaleString("en-IN")} to{" "}
            {handoff.sent_to_emails.map((e) => e.email).join(", ")} · {handoff.nudge_count} nudge(s)
          </p>
          {handoff.winning_nbfc_name && <p className="text-xs text-emerald-700">Winner: {handoff.winning_nbfc_name}</p>}
          {handoff.outcome && <p className="text-xs text-slate-600">Outcome: {handoff.outcome}</p>}
        </section>
      )}

      {/* Send / re-send */}
      <section className="border border-slate-200 rounded-xl bg-white p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">{handoff ? "Re-send" : "Send to NBFC(s)"}</h2>
        {rows.map((r, i) => (
          <div key={i} className="flex gap-2">
            <input
              value={r.email}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))}
              placeholder="NBFC email"
              className="flex-1 text-sm border border-slate-200 rounded-md px-2 py-1.5"
            />
            <input
              value={r.nbfc_name}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, nbfc_name: e.target.value } : x)))}
              placeholder="NBFC name (optional)"
              className="flex-1 text-sm border border-slate-200 rounded-md px-2 py-1.5"
            />
          </div>
        ))}
        <div className="flex gap-2">
          <button onClick={() => setRows([...rows, { email: "", nbfc_name: "" }])} className="text-xs text-[color:var(--color-brand-sky)] underline">
            + Add NBFC
          </button>
        </div>
        <button onClick={send} disabled={busy} className="px-4 py-2 rounded-md bg-[color:var(--color-brand-navy)] text-white text-sm font-semibold disabled:opacity-50">
          Send customer KYC
        </button>
      </section>

      {/* Record outcome */}
      {handoff && handoff.status === "sent" && (
        <section className="border border-slate-200 rounded-xl bg-white p-5 space-y-3">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">Record outcome</h2>
          <input
            value={winner}
            onChange={(e) => setWinner(e.target.value)}
            placeholder="Winning NBFC name (for acceptance)"
            className="w-full text-sm border border-slate-200 rounded-md px-2 py-1.5"
          />
          <textarea
            value={outcomeNote}
            onChange={(e) => setOutcomeNote(e.target.value)}
            rows={2}
            placeholder="Outcome notes (optional)"
            className="w-full text-sm border border-slate-200 rounded-md px-2 py-1.5"
          />
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => winner.trim() && call("/outcome", { result: "accepted", winning_nbfc_name: winner.trim(), outcome: outcomeNote || undefined })}
              disabled={busy || !winner.trim()}
              className="px-3 py-1.5 rounded-md bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50"
            >
              Accepted → re-enter Step 5
            </button>
            <button onClick={() => call("/outcome", { result: "declined", outcome: outcomeNote || undefined })} disabled={busy} className="px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-semibold disabled:opacity-50">
              All declined
            </button>
            <button onClick={() => call("/outcome", { result: "exhausted", outcome: outcomeNote || undefined })} disabled={busy} className="px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 text-xs font-semibold disabled:opacity-50">
              Mark exhausted
            </button>
          </div>
        </section>
      )}

      {/* §12.1 — terminal dead-end. Admin-confirmed when all avenues are exhausted. */}
      <section className="border border-amber-200 bg-amber-50 rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-amber-900">Financing Dead-End (§12)</h2>
        {deadEndDone ? (
          <p className="text-xs text-emerald-700 font-semibold">
            Marked Financing Unavailable. Finance data purged. The dealer can now convert this lead to a cash sale.
          </p>
        ) : (
          <>
            <p className="text-xs text-amber-800">
              Confirm only when every avenue is exhausted (all NBFCs declined / not selected, BRE zero-match,
              or the off-platform handoff went unanswered). Terminal and admin-confirmed.
            </p>
            <select
              value={deadEndCategory}
              onChange={(e) => setDeadEndCategory(e.target.value as typeof deadEndCategory)}
              className="text-sm border border-slate-200 rounded-md px-2 py-1.5 bg-white"
            >
              <option value="all_declined">All NBFCs declined / not selected</option>
              <option value="no_match">BRE zero-match (no eligible NBFC)</option>
              <option value="handoff_unanswered">Manual handoff unanswered</option>
            </select>
            <div>
              <button
                onClick={markFinancingUnavailable}
                disabled={busy}
                className="px-4 py-2 rounded-md bg-amber-700 text-white text-xs font-bold disabled:opacity-50"
              >
                Mark Financing Unavailable
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
