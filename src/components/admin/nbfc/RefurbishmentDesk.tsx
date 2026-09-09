"use client";

/**
 * E-292 — iTarang's refurbishment desk (v3).
 *
 * The middle desk of the v3 flow: review what NBFCs send, estimate, send the
 * proforma invoice, mark money received, sign for the trucks, hand the lot to
 * a refurbisher partner, price the final bill, and send it back. The detail
 * panel is the same component the NBFC console and the refurbisher portal
 * render, told which side it is on.
 *
 * SHAPE: a ledger, not a card grid. An admin arrives here to answer "what is
 * waiting on us" — that is a column scan. The open lot expands underneath the
 * row so the rest of the queue stays on screen.
 */
import { Fragment, useCallback, useEffect, useState } from "react";
import { formatINR } from "@/components/auction/AuctionPrimitives";
import RefurbLotDetail, {
  LotStatusChip,
  type LotAction,
  type LotView,
  type PhotoTarget,
  type RefurbisherOption,
} from "@/components/refurbishment/RefurbLotDetail";

const TABS = [
  { value: "open", label: "Open" },
  { value: "requested", label: "To review" },
  { value: "reviewed", label: "To estimate" },
  { value: "countered", label: "To re-estimate" },
  { value: "agreed", label: "Send PI" },
  { value: "pi_accepted", label: "Advance / ship" },
  { value: "in_transit_out", label: "Arriving" },
  { value: "received", label: "To assign" },
  { value: "at_refurbisher", label: "At refurbisher" },
  { value: "in_progress", label: "In work" },
  { value: "costed", label: "To bill" },
  { value: "ready", label: "To dispatch" },
  { value: "balance_due", label: "Balance" },
  { value: "settled", label: "Awaiting NBFC" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
] as const;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: init?.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) {
    const raw = typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(raw.replace(/^[A-Z_]+:\s*/, ""));
  }
  return body as T;
}

export default function RefurbishmentDesk() {
  const [tab, setTab] = useState<string>("open");
  const [rows, setRows] = useState<LotView[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LotView | null>(null);
  const [canAct, setCanAct] = useState(true);
  const [refurbishers, setRefurbishers] = useState<RefurbisherOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ items: LotView[]; counts: Record<string, number> }>(
        `/api/admin/nbfc/refurbishment/lots?status=${encodeURIComponent(tab)}`,
      );
      setRows(r.items ?? []);
      setCounts(r.counts ?? {});
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [tab]);
  useEffect(() => { void load(); }, [load]);

  // The refurbisher directory feeds the assign dropdown; one fetch on mount.
  useEffect(() => {
    api<{ items: RefurbisherOption[] }>("/api/admin/nbfc/refurbishers").then((r) => setRefurbishers(r.items ?? [])).catch(() => setRefurbishers([]));
  }, []);

  // Deep link from a notification: /admin/nbfc/refurbishment?open=<id>
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("open");
    if (id) setOpenId(id);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await api<{ lot: LotView; can_act: boolean }>(`/api/admin/nbfc/refurbishment/lots/${id}`);
      setDetail(r.lot);
      setCanAct(r.can_act !== false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    if (!openId) { setDetail(null); return; }
    void loadDetail(openId);
  }, [openId, loadDetail]);

  async function act(action: LotAction, payload: Record<string, unknown>): Promise<unknown> {
    if (!detail) return;
    setBusy(true);
    setFlash(null);
    try {
      const r = await api<{ lot: LotView }>(`/api/admin/nbfc/refurbishment/lots/${detail.id}`, {
        method: "POST",
        body: JSON.stringify({ action, ...payload }),
      });
      setDetail(r.lot);
      const said: Partial<Record<LotAction, string>> = {
        review: r.lot.status === "reviewed" && !(payload.decisions as unknown[])?.length ? "Marked reviewed — send the estimate next." : "Battery declined — the NBFC's register shows it as inspected again.",
        estimate: "Estimate sent to the NBFC.",
        cancel: "Lot cancelled.",
        "send-pi": "Proforma invoice sent to the NBFC.",
        "confirm-payment": r.lot.status === "settled" ? "Balance received — the lot is settled." : "Advance received — the batteries can move.",
        pickup: "Pickup recorded — in transit to iTarang.",
        arrive: "Marked arrived — now sign for each battery.",
        "confirm-receipt": "Receipt recorded and the NBFC told.",
        assign: `Assigned to ${r.lot.refurbisher?.name ?? "the refurbisher"}.`,
        "start-work": "Work started.",
        "cost-item": r.lot.status === "costed" ? "Every battery is costed — set the margin and send the final bill." : "Cost recorded.",
        "set-final-cost": "Final bill sent to the NBFC — mark the batteries ready.",
        "mark-ready": r.lot.status === "ready" ? "Every battery is ready — dispatch the lot back." : "Battery marked ready.",
        dispatch: "Return dispatch recorded — the NBFC will confirm receipt.",
        message: "Sent.",
      };
      if (said[action]) setFlash(said[action] ?? null);
      await load();
      return r;
    } catch (e) {
      setFlash(e instanceof Error ? e.message : String(e));
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
    try {
      const r = await api<{ paths: string[]; uploaded: number }>(`/api/admin/nbfc/refurbishment/lots/${detail.id}/photos`, { method: "POST", body: form });
      setFlash(target === "pi_document" ? "Proforma invoice attached." : `${r.uploaded} file(s) added`);
      return r.paths ?? [];
    } catch (e) {
      setFlash(e instanceof Error ? e.message : String(e));
      return [];
    }
  }

  const needsAnswer = rows.filter((r) => r.awaiting === "admin").length;
  const atRefurbisher = (counts.at_refurbisher ?? 0) + (counts.in_progress ?? 0) + (counts.costed ?? 0) + (counts.ready ?? 0);
  const money = (counts.pi_accepted ?? 0) + (counts.balance_due ?? 0);

  return (
    <div className="auction-sheet">
      <header style={{ marginBlockEnd: "1.5rem" }}>
        <p className="auc-eyebrow">NBFC · refurbishment</p>
        <h1 className="auc-h1">Refurbishment Desk</h1>
        <p className="auc-lede">
          Batteries NBFC partners send for refurbishment. Review each one, send an estimate, then the proforma invoice; mark the advance received, sign for the lot, hand it to a refurbisher, price the final bill and send it back — every step is pushed to the other side as it happens.
        </p>
      </header>

      <div className="auc-kpis">
        <div className="auc-kpi" data-tone={needsAnswer > 0 ? "warn" : undefined}><b>{needsAnswer}</b><span>Waiting on iTarang</span></div>
        <div className="auc-kpi"><b>{(counts.requested ?? 0) + (counts.reviewed ?? 0) + (counts.countered ?? 0)}</b><span>To review / estimate</span></div>
        <div className="auc-kpi" data-tone={money > 0 ? "warn" : undefined}><b>{money}</b><span>Money legs open</span></div>
        <div className="auc-kpi"><b>{atRefurbisher}</b><span>At refurbishers</span></div>
        <div className="auc-kpi" data-tone={(counts.costed ?? 0) > 0 ? "warn" : undefined}><b>{counts.costed ?? 0}</b><span>To bill</span></div>
        <div className="auc-kpi" data-tone="live"><b>{(counts.settled ?? 0) + (counts.closed ?? 0)}</b><span>Settled / closed</span></div>
      </div>

      <div className="auc-tabs" role="tablist" style={{ marginBlock: "1rem" }}>
        {TABS.map((t) => (
          <button key={t.value} type="button" role="tab" className="auc-tab" aria-selected={tab === t.value} onClick={() => setTab(t.value)}>
            {t.label}
          </button>
        ))}
      </div>

      {flash ? (
        <p className="auc-lede" role="status" style={{ border: "1px solid var(--auc-rule)", padding: ".6rem .75rem" }}>{flash}</p>
      ) : null}

      {error ? (
        <p className="auc-lede">{error}</p>
      ) : loading ? (
        <p className="auc-lede">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="auc-lede">Nothing in this view.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="auc-table">
            <thead><tr><th>Ref</th><th>NBFC</th><th>Batteries</th><th>Status</th><th>Waiting on</th><th>Refurbisher</th><th>Return by</th><th>Amount</th><th /></tr></thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                <tr>
                  <td style={{ fontFamily: "var(--font-mono, monospace)" }}>{r.ref_code}</td>
                  <td>{r.tenant_name ?? "—"}</td>
                  <td>{r.battery_count}</td>
                  <td><LotStatusChip status={r.status} /></td>
                  <td>{r.awaiting === "admin" ? "iTarang" : r.awaiting === "nbfc" ? (r.tenant_name ?? "NBFC") : r.awaiting === "refurbisher" ? (r.refurbisher?.name ?? "refurbisher") : "—"}</td>
                  <td>{r.refurbisher?.name ?? "—"}</td>
                  <td>{r.expected_return_date ? new Date(r.expected_return_date).toLocaleDateString("en-IN") : "—"}</td>
                  <td className="auc-num">{formatINR(r.final_total ?? r.pi.amount ?? r.estimated_total)}</td>
                  <td><button type="button" className="auc-btn" data-variant="ghost" onClick={() => setOpenId(r.id === openId ? null : r.id)}>{r.id === openId ? "Close" : "Open"}</button></td>
                </tr>
                {r.id === openId ? (
                  <tr>
                    <td colSpan={9} style={{ padding: 0 }}>
                      {detail && detail.id === r.id ? (
                        <div style={{ padding: "0.75rem 0 1rem" }}>
                          <RefurbLotDetail lot={detail} side="admin" canAct={canAct} busy={busy} onAction={act} onUpload={upload} refurbishers={refurbishers} />
                        </div>
                      ) : (
                        <p className="auc-subtle" style={{ padding: "0.75rem 1rem" }}>Loading lot…</p>
                      )}
                    </td>
                  </tr>
                ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </div>
  );
}
