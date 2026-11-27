"use client";

/**
 * 23 Nov 2026 (Battery Pool, tasks 8 + 9) — resume a file an NBFC rejected,
 * once the customer has sent corrected documents.
 *   • Same dealer → back to the same NBFC, or on to another NBFC.
 *   • Another dealer → a NEW case is created for that dealer; this rejected
 *     case stays as it is and is listed under "Resume history".
 * Renders nothing when the file was never rejected by an NBFC and has no
 * resume history.
 */
import { useCallback, useEffect, useState } from "react";

type Option = { nbfcId: number; loanProductId: number; label: string; detail: string };
type View = {
  ok: boolean;
  can_resume: boolean;
  blocked_reason: string | null;
  can_act: boolean;
  dealer_id: string | null;
  moved_to_lead_id: string | null;
  rejections: Array<{ assignment_id: string; nbfc_name: string; reason: string | null; decided_at: string | null }>;
  history: Array<{
    id: string;
    old_lead_id: string;
    new_lead_id: string;
    mode: string;
    from_dealer_id: string | null;
    to_dealer_id: string | null;
    rejection_reason: string | null;
    note: string | null;
    by: string | null;
    at: string;
  }>;
  other_nbfc_options: Option[];
};
type Dealer = { dealerId: string; name: string; financeEnabled: boolean };

const fmt = (ts: string | null) => (ts ? new Date(ts).toLocaleString("en-IN") : "—");

export default function ResumeRejectedPanel({ leadId }: { leadId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"same_nbfc" | "other_nbfc" | "new_dealer">("same_nbfc");
  const [note, setNote] = useState("");
  const [assignmentId, setAssignmentId] = useState("");
  const [scheme, setScheme] = useState("");
  const [q, setQ] = useState("");
  const [dealers, setDealers] = useState<Dealer[]>([]);
  const [dealer, setDealer] = useState<Dealer | null>(null);
  // 27 Nov — option 3: the lenders that fit this customer under the picked dealer.
  const [dealerOptions, setDealerOptions] = useState<Option[] | null>(null);
  const [dealerScheme, setDealerScheme] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string; link?: string } | null>(null);

  const base = `/api/admin/leads/${encodeURIComponent(leadId)}/resume`;
  const load = useCallback(async () => {
    const res = await fetch(base, { cache: "no-store" });
    const j = (await res.json().catch(() => null)) as View | null;
    setView(res.ok && j?.ok ? j : null);
  }, [base]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (mode !== "new_dealer" || q.trim().length < 2) {
      setDealers([]);
      return;
    }
    const t = setTimeout(async () => {
      const r = await fetch(`/api/leads/dealer-lookup?q=${encodeURIComponent(q.trim())}&finance=1`, { cache: "no-store" });
      const j = await r.json().catch(() => null);
      const list = (j?.data?.dealers ?? j?.dealers ?? []) as Dealer[];
      setDealers(list.filter((d) => d.dealerId !== view?.dealer_id));
    }, 300);
    return () => clearTimeout(t);
  }, [q, mode, view?.dealer_id]);

  useEffect(() => {
    setDealerScheme("");
    if (!dealer) {
      setDealerOptions(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const r = await fetch(`${base}?dealer=${encodeURIComponent(dealer.dealerId)}`, { cache: "no-store" });
      const j = (await r.json().catch(() => null)) as { ok?: boolean; dealer_options?: Option[] } | null;
      if (!cancelled) setDealerOptions(j?.ok ? j.dealer_options ?? [] : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [dealer, base]);

  async function submit() {
    if (!note.trim()) return setMsg({ tone: "err", text: "Write what the customer corrected." });
    let body: Record<string, unknown>;
    if (mode === "same_nbfc") body = { mode, note: note.trim(), ...(assignmentId ? { assignment_id: assignmentId } : {}) };
    else if (mode === "other_nbfc") {
      if (!scheme) return setMsg({ tone: "err", text: "Pick the lender and scheme." });
      const [nbfc_id, loan_product_id] = scheme.split(":").map(Number);
      body = { mode, note: note.trim(), nbfc_id, loan_product_id };
    } else {
      if (!dealer) return setMsg({ tone: "err", text: "Pick the dealer for the new case." });
      body = { mode, note: note.trim(), dealer_id: dealer.dealerId };
      if (dealerScheme) {
        const [nbfc_id, loan_product_id] = dealerScheme.split(":").map(Number);
        body = { ...body, nbfc_id, loan_product_id };
      }
    }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; leadId?: string; nbfcName?: string | null };
      if (!res.ok || !j.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      if (mode === "new_dealer") {
        setMsg({
          tone: "ok",
          text:
            `New case ${j.leadId} created for ${dealer?.name}` +
            (j.nbfcName ? `, lender ${j.nbfcName}` : ", lender chosen automatically at Step 4") +
            ". This rejected case stays here as history.",
          link: `/admin/kyc-review/${j.leadId}`,
        });
      } else {
        setMsg({ tone: "ok", text: `File resumed — sent to ${j.nbfcName ?? "the lender"}.` });
      }
      setOpen(false);
      setNote("");
      await load();
    } catch (e) {
      setMsg({ tone: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  if (!view) return null;
  if (!view.rejections.length && !view.history.length) return null;

  return (
    <section className="mb-3 rounded-xl border border-rose-200 bg-rose-50/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">Rejected by NBFC — resume</h3>
        {view.can_resume && view.can_act && !open ? (
          <button
            onClick={() => {
              setOpen(true);
              setMsg(null);
            }}
            className="rounded bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white"
          >
            Resume with corrected documents
          </button>
        ) : null}
      </div>

      {view.rejections.length ? (
        <ul className="mt-2 space-y-1 text-xs text-slate-700">
          {view.rejections.map((r) => (
            <li key={r.assignment_id}>
              <b>{r.nbfc_name}</b> rejected on {fmt(r.decided_at)}
              {r.reason ? <> — {r.reason}</> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!view.can_resume && view.blocked_reason ? (
        <p className="mt-2 text-[11px] text-slate-500">
          {view.blocked_reason}
          {view.moved_to_lead_id ? (
            <>
              {" "}
              <a className="text-sky-700 underline" href={`/admin/kyc-review/${view.moved_to_lead_id}`}>
                Open {view.moved_to_lead_id}
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      {open ? (
        <div className="mt-3 space-y-3 rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-[11px] text-slate-500">
            Make sure the customer&apos;s corrected documents are uploaded on the file first (KYC documents / additional
            documents). Then choose where it goes.
          </p>
          <div className="flex flex-wrap gap-4 text-sm">
            {(
              [
                ["same_nbfc", "Same dealer · same NBFC"],
                ["other_nbfc", "Same dealer · another NBFC"],
                ["new_dealer", "Another dealer + an NBFC (new case)"],
              ] as const
            ).map(([m, label]) => (
              <label key={m} className="flex items-center gap-1.5">
                <input type="radio" checked={mode === m} onChange={() => setMode(m)} /> {label}
              </label>
            ))}
          </div>

          {mode === "same_nbfc" && view.rejections.length > 1 ? (
            <select
              value={assignmentId}
              onChange={(e) => setAssignmentId(e.target.value)}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm"
            >
              <option value="">Latest rejection ({view.rejections[0].nbfc_name})</option>
              {view.rejections.map((r) => (
                <option key={r.assignment_id} value={r.assignment_id}>
                  {r.nbfc_name}
                </option>
              ))}
            </select>
          ) : null}

          {mode === "other_nbfc" ? (
            view.other_nbfc_options.length ? (
              <select
                value={scheme}
                onChange={(e) => setScheme(e.target.value)}
                className="min-w-[18rem] rounded border border-slate-300 px-2 py-1.5 text-sm"
              >
                <option value="">Choose lender + scheme…</option>
                {view.other_nbfc_options.map((o) => (
                  <option key={`${o.nbfcId}:${o.loanProductId}`} value={`${o.nbfcId}:${o.loanProductId}`}>
                    {o.label} · {o.detail}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-amber-700">No other lender fits this lead right now.</p>
            )
          ) : null}

          {mode === "new_dealer" ? (
            <div className="space-y-1.5">
              <input
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setDealer(null);
                }}
                placeholder="Search dealer by name or mobile (finance-enabled dealers)"
                className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
              />
              {dealer ? (
                <div className="space-y-1.5">
                  <p className="text-xs text-emerald-700">Selected dealer: {dealer.name}</p>
                  {dealerOptions === null ? (
                    <p className="text-xs text-slate-500">Checking which lenders fit under this dealer…</p>
                  ) : dealerOptions.length ? (
                    <select
                      value={dealerScheme}
                      onChange={(e) => setDealerScheme(e.target.value)}
                      className="min-w-[18rem] rounded border border-slate-300 px-2 py-1.5 text-sm"
                    >
                      <option value="">NBFC: choose automatically at Step 4 (routing rule / best fit)</option>
                      {dealerOptions.map((o) => (
                        <option key={`${o.nbfcId}:${o.loanProductId}`} value={`${o.nbfcId}:${o.loanProductId}`}>
                          {o.label} · {o.detail}
                          {view.rejections.some((r) => o.label.startsWith(`${r.nbfc_name} —`)) ? " · rejected this customer before" : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <p className="text-xs text-amber-700">
                      No lender fits this customer under {dealer.name} — pick another dealer.
                    </p>
                  )}
                </div>
              ) : dealers.length ? (
                <ul className="max-h-40 overflow-auto rounded border border-slate-200">
                  {dealers.map((d) => (
                    <li key={d.dealerId}>
                      <button
                        type="button"
                        onClick={() => setDealer(d)}
                        className="w-full px-2 py-1 text-left text-sm hover:bg-slate-50"
                      >
                        {d.name} <span className="text-[11px] text-slate-400">{d.dealerId}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="text-[11px] text-slate-500">
                A new case is created for this dealer with the customer&apos;s details and KYC documents (re-verified);
                the dealer takes the consent again and submits. This rejected case is kept as history.
              </p>
            </div>
          ) : null}

          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={1000}
            placeholder="What did the customer correct? (required) — e.g. new bank statement, corrected PAN…"
            className="w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
          <div className="flex gap-2">
            <button
              onClick={submit}
              disabled={busy}
              className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Resuming…" : mode === "new_dealer" ? "Create new case" : "Resume file"}
            </button>
            <button onClick={() => setOpen(false)} disabled={busy} className="text-xs text-slate-500 hover:underline">
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {msg ? (
        <p className={`mt-2 text-xs ${msg.tone === "ok" ? "text-emerald-700" : "text-red-700"}`}>
          {msg.text}{" "}
          {msg.link ? (
            <a className="underline" href={msg.link}>
              Open the new case
            </a>
          ) : null}
        </p>
      ) : null}

      {view.history.length ? (
        <div className="mt-3 border-t border-rose-100 pt-2">
          <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Resume history</p>
          <ul className="mt-1 space-y-1 text-[11px] text-slate-600">
            {view.history.map((h) => (
              <li key={h.id}>
                {fmt(h.at)} · {h.by ?? "iTarang"} ·{" "}
                {h.mode === "new_dealer" ? (
                  h.old_lead_id === leadId ? (
                    <>
                      new case{" "}
                      <a className="text-sky-700 underline" href={`/admin/kyc-review/${h.new_lead_id}`}>
                        {h.new_lead_id}
                      </a>{" "}
                      for dealer {h.to_dealer_id}
                    </>
                  ) : (
                    <>
                      created from rejected case{" "}
                      <a className="text-sky-700 underline" href={`/admin/kyc-review/${h.old_lead_id}`}>
                        {h.old_lead_id}
                      </a>{" "}
                      (dealer {h.from_dealer_id})
                    </>
                  )
                ) : (
                  <>resumed with the same dealer</>
                )}
                {h.rejection_reason ? ` · rejected for: ${h.rejection_reason}` : ""}
                {h.note ? ` · corrected: ${h.note}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
