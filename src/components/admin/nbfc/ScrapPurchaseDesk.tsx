"use client";

/**
 * E-258 — iTarang's scrap purchase desk.
 *
 * The buying end of what an NBFC posts from /nbfc/recovery/scrap. Same deal,
 * same photographs, same thread — the detail panel is literally the same
 * component, told which side it is on.
 *
 * SHAPE: a ledger, not a card grid. An admin arrives here to answer "what is
 * waiting on us and how much would it cost", and that is a column scan. The
 * open deal expands underneath the row rather than in a modal, so the rest of
 * the queue stays on screen while a price is being decided.
 *
 * DEFAULT VIEW IS `open`. A list dominated by last quarter's settled purchases
 * is a report, not an inbox.
 */
import { useCallback, useEffect, useState } from "react";
import { formatINR } from "@/components/auction/AuctionPrimitives";
import ConsignmentDetail, {
  rateOnTable,
  type ConsignmentView,
  type ScrapAction,
} from "@/components/scrap/ConsignmentDetail";

const TABS = [
  { value: "open", label: "Needs an answer" },
  { value: "agreed", label: "Agreed · to pay" },
  { value: "paid", label: "Bought" },
  { value: "rejected", label: "Declined" },
  { value: "all", label: "All" },
] as const;

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    cache: "no-store",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) {
    const raw =
      typeof body?.error === "string" ? body.error : `HTTP ${res.status}`;
    throw new Error(raw.replace(/^[A-Z_]+:\s*/, ""));
  }
  return body as T;
}

export default function ScrapPurchaseDesk() {
  const [tab, setTab] = useState<string>("open");
  const [rows, setRows] = useState<ConsignmentView[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConsignmentView | null>(null);
  // Two capabilities, not one: pricing a lot and paying for it are separate
  // permissions on the server (SCRAP_NEGOTIATE_ROLES vs SCRAP_PAY_ROLES), so
  // a sales_head sees the counter form but not the Pay button.
  const [canNegotiate, setCanNegotiate] = useState(true);
  const [canPay, setCanPay] = useState(true);
  // [E-259] The NBFC's scrap payment term, read live per consignment.
  const [timing, setTiming] = useState<"pre_lot" | "post_lot">("post_lot");
  const [timingIsSet, setTimingIsSet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{
        items: ConsignmentView[];
        counts: Record<string, number>;
      }>(`/api/admin/nbfc/scrap/consignments?status=${encodeURIComponent(tab)}`);
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

  useEffect(() => {
    void load();
  }, [load]);

  // Deep link from a notification: /admin/nbfc/scrap?open=<id>
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("open");
    if (id) setOpenId(id);
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const r = await api<{
        consignment: ConsignmentView;
        can_negotiate: boolean;
        can_pay: boolean;
        payment_timing?: "pre_lot" | "post_lot";
        payment_timing_is_set?: boolean;
      }>(`/api/admin/nbfc/scrap/consignments/${id}`);
      setDetail(r.consignment);
      setCanNegotiate(r.can_negotiate !== false);
      setCanPay(r.can_pay !== false);
      setTiming(r.payment_timing ?? "post_lot");
      setTimingIsSet(r.payment_timing_is_set === true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    void loadDetail(openId);
  }, [openId, loadDetail]);

  async function act(
    action: ScrapAction,
    payload: {
      rate_per_battery?: number;
      /** [E-260] The countered total, on an itemised lot. */
      amount?: number;
      /** [E-261] item_id → rate, when countering battery by battery. */
      item_rates?: Record<string, number>;
      message?: string;
      reference?: string;
    },
  ) {
    if (!detail) return;
    setBusy(true);
    setFlash(null);
    try {
      const r = await api<{
        consignment?: ConsignmentView;
        payment_status?: string;
        gateway_unavailable?: boolean;
        message?: string;
        utr?: string | null;
      }>(`/api/admin/nbfc/scrap/consignments/${detail.id}`, {
        method: "POST",
        body: JSON.stringify({ action, ...payload }),
      });

      if (r.consignment) setDetail(r.consignment);
      else await loadDetail(detail.id);

      // The payout branch answers with a state, not just a row: "queued",
      // "gateway not configured", "failed". Surfacing that verbatim is the
      // whole point — an admin who clicked Pay needs to know whether money
      // actually moved.
      if (r.gateway_unavailable) {
        setFlash(
          r.message ??
            "RazorpayX is not configured here — pay by bank transfer and record it with the reference.",
        );
      } else if (r.message) {
        setFlash(r.message);
      } else if (action === "accept") {
        setFlash("Rate agreed. Pay to take the lot.");
      } else if (action === "counter") {
        setFlash("Your price is with the NBFC.");
      }

      await load();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const needsAnswer = rows.filter((r) => r.awaiting === "admin" && r.status !== "agreed").length;
  const toPay = rows.filter((r) => r.status === "agreed").length;
  const exposure = rows
    .filter((r) => r.status === "agreed")
    .reduce((s, r) => s + (r.agreed_amount ?? 0), 0);

  return (
    <div className="auction-sheet">
      <header style={{ marginBlockEnd: "1.5rem" }}>
        <p className="auc-eyebrow">NBFC · scrap purchase</p>
        <h1 className="auc-h1">Scrap Purchase Desk</h1>
        <p className="auc-lede">
          Scrap batteries offered to iTarang by its NBFC partners. Price is a
          rate per battery; accepting freezes it, and paying transfers the lot
          into iTarang&rsquo;s hands.
        </p>
      </header>

      <div className="auc-kpis">
        <div className="auc-kpi" data-tone={needsAnswer > 0 ? "warn" : undefined}>
          <b>{needsAnswer}</b>
          <span>Waiting on iTarang</span>
        </div>
        <div className="auc-kpi" data-tone={toPay > 0 ? "warn" : undefined}>
          <b>{toPay}</b>
          <span>Agreed, unpaid</span>
        </div>
        <div className="auc-kpi">
          <b>{formatINR(exposure)}</b>
          <span>Owed to NBFCs</span>
        </div>
        <div className="auc-kpi" data-tone="live">
          <b>{counts.paid ?? 0}</b>
          <span>Bought</span>
        </div>
      </div>

      <div className="auc-tabs" role="tablist" style={{ marginBlock: "1rem" }}>
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            className="auc-tab"
            aria-selected={tab === t.value}
            onClick={() => setTab(t.value)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {flash ? (
        <p
          className="auc-lede"
          role="status"
          style={{ border: "1px solid var(--auc-rule)", padding: ".6rem .75rem" }}
        >
          {flash}
        </p>
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
            <thead>
              <tr>
                <th>Ref</th>
                <th>NBFC</th>
                <th>Batteries</th>
                <th>Rate on table</th>
                <th>Lot value</th>
                <th>Status</th>
                <th>Waiting on</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                // The list rows carry no offers array, so rateOnTable() falls
                // back to the agreed rate and then the NBFC's ask — which is
                // exactly the right answer for a summary column.
                const table = rateOnTable(r);
                return (
                  <tr key={r.id}>
                    <td style={{ fontFamily: "var(--font-mono, monospace)" }}>
                      {r.ref_code}
                    </td>
                    <td>{r.tenant_name ?? "—"}</td>
                    <td>{r.battery_count}</td>
                    <td>{formatINR(table)}</td>
                    <td>
                      {formatINR(
                        r.agreed_amount ??
                          (table != null ? table * r.battery_count : null),
                      )}
                    </td>
                    <td>
                      <span
                        className="auc-chip"
                        data-tone={
                          r.status === "paid" || r.status === "agreed"
                            ? "live"
                            : r.status === "submitted" || r.status === "negotiating"
                              ? "warn"
                              : "muted"
                        }
                      >
                        {r.status}
                      </span>
                    </td>
                    <td>
                      {r.awaiting === "admin"
                        ? "iTarang"
                        : r.awaiting === "nbfc"
                          ? (r.tenant_name ?? "NBFC")
                          : "—"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="auc-btn"
                        data-variant="ghost"
                        onClick={() => setOpenId(r.id === openId ? null : r.id)}
                      >
                        {r.id === openId ? "Close" : "Open"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {detail ? (
        <div style={{ marginBlockStart: "1rem" }}>
          <ConsignmentDetail
            consignment={detail}
            side="admin"
            canNegotiate={canNegotiate}
            canPay={canPay}
            paymentTiming={timing}
            paymentTimingIsSet={timingIsSet}
            busy={busy}
            onAction={act}
          />
        </div>
      ) : null}
    </div>
  );
}
