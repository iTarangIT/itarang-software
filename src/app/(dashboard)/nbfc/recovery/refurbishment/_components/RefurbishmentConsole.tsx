"use client";

/**
 * E-270 — the NBFC's refurbishment console.
 *
 * Before E-270 this screen raised ONE job at a time and then let the NBFC
 * press "Start work" / "Mark returned" on behalf of a workshop it does not
 * run. Now it sends a LOT — one or many inspected batteries — and every step
 * after that is the workshop's, pushed back here as it happens:
 *
 *   send batch → iTarang reviews + proposes timeline & estimate → accept or
 *   ask for changes → dispatch (docket, photos) → iTarang signs for each
 *   battery → work → iTarang dispatches back → sign for each battery →
 *   battery is `ready`, graded `refurbished`, cost rolled into the lot price.
 *
 * The detail panel is the same component the admin desk renders, told which
 * side it is on (src/components/refurbishment/RefurbLotDetail.tsx).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { nbfcFetch, formatINR } from "@/lib/auction/client";
import RefurbLotDetail, {
  LotStatusChip,
  type LotAction,
  type LotView,
  type PhotoTarget,
} from "@/components/refurbishment/RefurbLotDetail";

const TABS = [
  { key: "open", label: "Open" },
  { key: "proposed", label: "Quote to approve" },
  { key: "awaiting_advance", label: "Advance due" },
  { key: "agreed", label: "To dispatch" },
  { key: "revision_pending", label: "Revision to approve" },
  { key: "in_transit_return", label: "Coming back" },
  { key: "balance_due", label: "Balance due" },
  { key: "settled", label: "Settled" },
  { key: "all", label: "All" },
] as const;

interface Eligible {
  id: string;
  serial: string;
  model: string | null;
  capacity: string | null;
  condition_grade: string | null;
  soh_pct: number | null;
  image_urls: string[];
  blocked_reason: string | null;
  last_decline_reason: string | null;
  last_declined_at: string | null;
}

export default function RefurbishmentConsole() {
  const [tab, setTab] = useState<string>("open");
  const [rows, setRows] = useState<LotView[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LotView | null>(null);
  const [busy, setBusy] = useState(false);

  // — new lot —
  const [composing, setComposing] = useState(false);
  const [eligible, setEligible] = useState<Eligible[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await nbfcFetch<{ items: LotView[]; counts: Record<string, number> }>(
        `/api/nbfc/recovery/refurbishment/lots?status=${encodeURIComponent(tab)}`,
      );
      setRows(r.items ?? []);
      setCounts(r.counts ?? {});
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [tab]);
  useEffect(() => { void load(); }, [load]);

  // Deep link from a notification: ?open=<id>
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("open");
    if (id) setOpenId(id);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await nbfcFetch<{ lot: LotView }>(`/api/nbfc/recovery/refurbishment/lots/${id}`);
      setDetail(r.lot);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      setOpenId(null);
    }
  }, []);
  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    void loadDetail(openId);
  }, [openId, loadDetail]);

  useEffect(() => {
    if (!composing || eligible) return;
    nbfcFetch<{ items: Eligible[] }>("/api/nbfc/recovery/refurbishment/eligible-batteries")
      .then((r) => setEligible(r.items))
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));
  }, [composing, eligible]);

  async function sendLot() {
    if (picked.size === 0) { toast.error("Pick at least one battery."); return; }
    setBusy(true);
    try {
      const r = await nbfcFetch<{ lot: LotView }>("/api/nbfc/recovery/refurbishment/lots", {
        method: "POST",
        body: JSON.stringify({ battery_ids: Array.from(picked), note: note.trim() || null }),
      });
      toast.success(`${r.lot.ref_code} sent to the iTarang workshop`);
      setComposing(false);
      setPicked(new Set());
      setNote("");
      setEligible(null);
      setTab("open");
      setOpenId(r.lot.id);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function act(action: LotAction, payload: Record<string, unknown>): Promise<unknown> {
    if (!detail) return;
    setBusy(true);
    try {
      const r = await nbfcFetch<{ lot?: LotView; intent?: unknown }>(`/api/nbfc/recovery/refurbishment/lots/${detail.id}`, {
        method: "POST",
        body: JSON.stringify({ action, ...payload }),
      });
      // `pay-order` answers with a payment intent, not a lot — hand it back to
      // the pay panel, which opens Checkout with it.
      if (action === "pay-order") return r;
      if (r.lot) setDetail(r.lot);
      const said: Partial<Record<LotAction, string>> = {
        accept: "Quote approved.",
        "approve-quote": "Quote approved.",
        arrive: "Marked arrived — now check each battery.",
        "pay-verify": "Payment received.",
        "record-payment": "Recorded — iTarang will confirm the transfer.",
        "approve-revision": "Revised quote approved.",
        "reject-revision": "Revision rejected — the approved quote stands.",
        counter: "Sent to iTarang.",
        cancel: "Lot cancelled; the batteries are back at inspected.",
        dispatch: "Dispatch recorded — iTarang will confirm receipt.",
        "confirm-receipt": "Receipt recorded.",
        message: "Sent.",
      };
      if (said[action]) toast.success(said[action]);
      await load();
      return r;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function upload(target: PhotoTarget, files: FileList): Promise<string[]> {
    if (!detail) return [];
    const form = new FormData();
    for (const f of Array.from(files)) form.append("file", f);
    form.append("target", target);
    const res = await fetch(`/api/nbfc/recovery/refurbishment/lots/${detail.id}/photos`, { method: "POST", body: form });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.ok === false) {
      const m = (typeof body?.error === "string" ? body.error : `HTTP ${res.status}`).replace(/^[A-Z_]+:\s*/, "");
      toast.error(m);
      return [];
    }
    toast.success(`${body.uploaded} photograph(s) added`);
    return body.paths ?? [];
  }

  const eligibleOk = useMemo(() => (eligible ?? []).filter((b) => !b.blocked_reason), [eligible]);
  const needsMe = rows.filter((r) => r.awaiting === "nbfc").length;

  return (
    <>
      <div className="auc-kpis">
        <div className="auc-kpi" data-tone={needsMe > 0 ? "warn" : undefined}><b>{needsMe}</b><span>Waiting on you</span></div>
        <div className="auc-kpi"><b>{counts.open ?? 0}</b><span>Open lots</span></div>
        <div className="auc-kpi"><b>{(counts.received ?? 0) + (counts.in_progress ?? 0) + (counts.ready ?? 0)}</b><span>At the workshop</span></div>
        <div className="auc-kpi" data-tone={(counts.awaiting_advance ?? 0) + (counts.balance_due ?? 0) > 0 ? "warn" : undefined}><b>{(counts.awaiting_advance ?? 0) + (counts.balance_due ?? 0)}</b><span>Payments due</span></div>
        <div className="auc-kpi" data-tone="live"><b>{counts.settled ?? 0}</b><span>Settled</span></div>
      </div>

      <div className="auc-toolbar">
        <div className="auc-tabs" role="tablist" style={{ flex: "1 1 auto" }}>
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" className="auc-tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="auc-toolbar-end">
          <button type="button" className="auc-btn" onClick={() => setComposing((v) => !v)}>
            {composing ? "Close" : "Send batteries to refurbish"}
          </button>
        </div>
      </div>

      {composing ? (
        <section className="auc-panel" style={{ marginBlockEnd: "1.5rem" }}>
          <header><span className="auc-panel-n">＋</span><h3>New refurbishment lot</h3></header>
          <div className="auc-panel-body">
            <span className="auc-hint">
              Tick the batteries to send — one lot, one job per battery. Only inspected batteries at or above the 70 % threshold are eligible; iTarang re-checks this on receipt of the request.
            </span>
            {!eligible ? (
              <p className="auc-subtle" style={{ marginBlockStart: ".5rem" }}>Loading batteries…</p>
            ) : eligible.length === 0 ? (
              <p className="auc-subtle" style={{ marginBlockStart: ".5rem" }}>No inspected batteries. Evaluate recovered batteries on the recovery board first.</p>
            ) : (
              <div style={{ overflowX: "auto", marginBlockStart: ".5rem" }}>
                <table className="auc-table">
                  <thead>
                    <tr>
                      <th>
                        <input type="checkbox" aria-label="select all eligible" checked={eligibleOk.length > 0 && eligibleOk.every((b) => picked.has(b.id))}
                          onChange={(e) => setPicked(e.target.checked ? new Set(eligibleOk.map((b) => b.id)) : new Set())} />
                      </th>
                      <th>Serial</th><th>Model</th><th>SOH</th><th>Grade</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {eligible.map((b) => (
                      <tr key={b.id} style={b.blocked_reason ? { opacity: 0.55 } : undefined}>
                        <td>
                          <input type="checkbox" disabled={!!b.blocked_reason} checked={picked.has(b.id)}
                            onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(b.id); else n.delete(b.id); return n; })} />
                        </td>
                        <td><span className="auc-pick-serial">{b.serial}</span></td>
                        <td>{b.model ?? "—"}{b.capacity ? ` · ${b.capacity}` : ""}</td>
                        <td>{b.soh_pct != null ? `${b.soh_pct}%` : "—"}</td>
                        <td>{b.condition_grade ?? "—"}</td>
                        <td className="auc-subtle">
                          {b.blocked_reason ?? ""}
                          {b.last_decline_reason ? (
                            <div style={{ color: "var(--auc-warn)" }}>iTarang declined this before: {b.last_decline_reason}{b.last_declined_at ? ` (${new Date(b.last_declined_at).toLocaleDateString("en-IN")})` : ""} — fix that before resubmitting.</div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="auc-field" style={{ marginBlockStart: ".75rem" }}>
              <label htmlFor="rl-note">Note to iTarang</label>
              <textarea id="rl-note" className="auc-text" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Known faults, urgency, where the batteries are." />
            </div>
            <div className="auc-linkrow" style={{ marginBlockStart: ".75rem" }}>
              <button type="button" className="auc-btn" disabled={busy || picked.size === 0} onClick={sendLot}>
                {busy ? "Sending…" : `Send ${picked.size || ""} ${picked.size === 1 ? "battery" : "batteries"} to refurbish`}
              </button>
              <button type="button" className="auc-btn" data-variant="ghost" onClick={() => setComposing(false)}>Cancel</button>
            </div>
          </div>
        </section>
      ) : null}

      {loading ? (
        <div className="auc-stack" style={{ marginBlockStart: "1.25rem" }}>{[0, 1].map((i) => <div key={i} className="auc-skel" style={{ height: "4rem" }} />)}</div>
      ) : error ? (
        <div className="auc-inline-error" style={{ marginBlockStart: "1.25rem" }}>{error}</div>
      ) : rows.length === 0 ? (
        <div className="auc-empty" style={{ marginBlockStart: "1.25rem" }}>
          <p>No lots in this view</p>
          <p className="auc-empty-hint">Send inspected batteries to the iTarang workshop with the button above. Repair is recommended, never mandatory — a battery graded partial working can go straight to auction.</p>
        </div>
      ) : (
        <div style={{ overflowX: "auto", marginBlockStart: "1rem" }}>
          <table className="auc-table">
            <thead><tr><th>Ref</th><th>Batteries</th><th>Status</th><th>Waiting on</th><th>Return by</th><th>Estimate</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontFamily: "var(--font-mono, monospace)" }}>{r.ref_code}</td>
                  <td>{r.battery_count}</td>
                  <td><LotStatusChip status={r.status} /></td>
                  <td>{r.awaiting === "nbfc" ? "You" : r.awaiting === "admin" ? "iTarang" : "—"}</td>
                  <td>{r.expected_return_date ? new Date(r.expected_return_date).toLocaleDateString("en-IN") : "—"}</td>
                  <td className="auc-num">{formatINR(r.estimated_total)}</td>
                  <td><button type="button" className="auc-btn" data-variant="ghost" onClick={() => setOpenId(r.id === openId ? null : r.id)}>{r.id === openId ? "Close" : "Open"}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail ? (
        <div style={{ marginBlockStart: "1rem" }}>
          <RefurbLotDetail lot={detail} side="nbfc" canAct busy={busy} onAction={act} onUpload={upload} />
        </div>
      ) : null}
    </>
  );
}
