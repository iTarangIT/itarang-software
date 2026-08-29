"use client";

/**
 * E-258 — the NBFC's scrap desk.
 *
 * THREE THINGS ON ONE SCREEN, because they are one job:
 *   1. the batteries that are scrap and not yet offered (the picker),
 *   2. the consignments already with iTarang (the ledger),
 *   3. whichever one is open (the deal).
 *
 * WHY THE PICKER IS A MULTI-SELECT TABLE AND NOT A WIZARD. Scrap is sold by
 * the pile: an operator selects everything in the corner of the warehouse and
 * sends it as one lot. A per-battery wizard would make a 40-battery
 * consignment forty screens for no added accuracy — the per-unit detail that
 * matters (serial, photos) is already on the battery.
 *
 * PHOTOGRAPHS ARE THE OFFER. The submit button stays disabled until at least
 * one picture exists, because iTarang is being asked to price batteries it
 * cannot touch. The check is enforced server-side too; this is just the honest
 * version of the message.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { formatINR } from "@/components/auction/AuctionPrimitives";
import ConsignmentDetail, {
  type ConsignmentView,
  type ScrapAction,
} from "@/components/scrap/ConsignmentDetail";

interface EligibleBattery {
  id: string;
  serial: string;
  model: string | null;
  capacity: string | null;
  state_code: string;
  pipeline_stage: string | null;
  warehouse: string | null;
  city: string | null;
  state: string | null;
  image_urls: string[];
  recovery_date: string | null;
}

/**
 * Same rule the route enforces (4 letters, a 0, then 6 alphanumerics). Checked
 * here as well so a mistyped code is caught under the field that is wrong,
 * rather than as a toast after a round-trip that also discarded the draft.
 */
const IFSC_RE = /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/;

const TABS = [
  { value: "open", label: "With iTarang" },
  { value: "draft", label: "Drafts" },
  { value: "paid", label: "Sold" },
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
    // The routes carry a `KIND: ` prefix so they can pick a status code; it is
    // not something to put in front of an operator.
    throw new Error(raw.replace(/^[A-Z_]+:\s*/, ""));
  }
  return body as T;
}

export default function ScrapDesk() {
  const [tab, setTab] = useState<string>("open");
  const [rows, setRows] = useState<ConsignmentView[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConsignmentView | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // The builder
  const [building, setBuilding] = useState(false);
  const [eligible, setEligible] = useState<EligibleBattery[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [rate, setRate] = useState("");
  // [E-260] 'flat' = one rate for the whole lot; 'itemised' = a rate per
  // battery. Both drafts are kept side by side rather than one being cleared
  // when the mode flips: an operator who types five rates, switches to flat to
  // compare, and switches back should not have lost them.
  const [mode, setMode] = useState<"flat" | "itemised">("flat");
  const [itemRates, setItemRates] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [payee, setPayee] = useState({ name: "", account: "", ifsc: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{
        items: ConsignmentView[];
        counts: Record<string, number>;
      }>(`/api/nbfc/scrap/consignments?status=${encodeURIComponent(tab)}`);
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

  // Deep link from a notification: /nbfc/recovery/scrap?open=<id>
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get("open");
    if (id) setOpenId(id);
  }, []);

  useEffect(() => {
    if (!openId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const r = await api<{ consignment: ConsignmentView }>(
          `/api/nbfc/scrap/consignments/${openId}`,
        );
        if (!cancelled) setDetail(r.consignment);
      } catch (e) {
        if (!cancelled) toast.error(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [openId]);

  const loadEligible = useCallback(async () => {
    try {
      const r = await api<{ items: EligibleBattery[] }>(
        "/api/nbfc/scrap/eligible-batteries",
      );
      setEligible(r.items ?? []);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, []);

  function startBuilding() {
    setBuilding(true);
    setPicked(new Set());
    void loadEligible();
  }

  const pickedList = useMemo(
    () => eligible.filter((b) => picked.has(b.id)),
    [eligible, picked],
  );
  const pickedPhotos = pickedList.reduce((n, b) => n + b.image_urls.length, 0);
  // The itemised total counts only batteries that are BOTH picked and priced,
  // so the figure on screen is always the sum of what would actually be sent.
  const itemisedTotal = pickedList.reduce((sum, b) => {
    const n = Number(itemRates[b.id]);
    return Number.isFinite(n) && n > 0 ? sum + n : sum;
  }, 0);
  const pricedCount = pickedList.filter(
    (b) => Number(itemRates[b.id]) > 0,
  ).length;
  const unpricedCount = pickedList.length - pricedCount;
  const draftTotal =
    mode === "itemised"
      ? itemisedTotal > 0
        ? itemisedTotal
        : null
      : Number(rate) > 0
        ? Number(rate) * pickedList.length
        : null;
  const ifscTyped = payee.ifsc.trim().length > 0;
  const ifscOk = IFSC_RE.test(payee.ifsc.trim());

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function createDraft(thenSubmit: boolean) {
    if (picked.size === 0) {
      toast.error("Pick at least one battery.");
      return;
    }
    // [E-260] What counts as priced depends on the mode. A draft may be
    // half-priced — the server only insists on completeness at submit — but
    // there has to be at least one number, or there is nothing to save.
    if (mode === "flat" && !(Number(rate) > 0)) {
      toast.error("Name a rate per battery.");
      return;
    }
    if (mode === "itemised") {
      if (pricedCount === 0) {
        toast.error("Price at least one battery.");
        return;
      }
      if (thenSubmit && unpricedCount > 0) {
        toast.error(
          `Price all ${picked.size} batteries before sending — ${unpricedCount} still ${unpricedCount === 1 ? "has" : "have"} no rate.`,
        );
        return;
      }
    }
    if (ifscTyped && !ifscOk) {
      toast.error(
        "That IFSC is not valid — 11 characters: 4 letters, a 0, then 6 more.",
      );
      return;
    }
    setBusy(true);
    try {
      const created = await api<{ consignment: ConsignmentView }>(
        "/api/nbfc/scrap/consignments",
        {
          method: "POST",
          body: JSON.stringify({
            battery_ids: [...picked],
            pricing_mode: mode,
            // Only the field its mode owns is sent. Sending both would leave
            // the server holding two prices and having to pick.
            asking_rate_per_battery:
              mode === "flat" ? Number(rate) : undefined,
            item_rates:
              mode === "itemised"
                ? Object.fromEntries(
                    pickedList
                      .filter((b) => Number(itemRates[b.id]) > 0)
                      .map((b) => [b.id, Number(itemRates[b.id])]),
                  )
                : undefined,
            note: note.trim() || undefined,
            payee_name: payee.name.trim() || undefined,
            payee_account_number: payee.account.trim() || undefined,
            payee_ifsc: payee.ifsc.trim() || undefined,
          }),
        },
      );
      const id = created.consignment.id;

      if (thenSubmit) {
        const sent = await api<{ consignment: ConsignmentView }>(
          `/api/nbfc/scrap/consignments/${id}`,
          {
            method: "POST",
            body: JSON.stringify({ action: "submit", message: note.trim() || undefined }),
          },
        );
        toast.success(`${sent.consignment.ref_code} sent to iTarang`);
      } else {
        toast.success(`${created.consignment.ref_code} saved as a draft`);
      }

      setBuilding(false);
      setRate("");
      setItemRates({});
      setMode("flat");
      setNote("");
      setPicked(new Set());
      setOpenId(id);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function act(
    action: ScrapAction,
    payload: {
      rate_per_battery?: number;
      amount?: number;
      /** [E-261] item_id → rate, when countering battery by battery. */
      item_rates?: Record<string, number>;
      message?: string;
    },
  ) {
    if (!detail) return;
    setBusy(true);
    try {
      const r = await api<{ consignment: ConsignmentView }>(
        `/api/nbfc/scrap/consignments/${detail.id}`,
        { method: "POST", body: JSON.stringify({ action, ...payload }) },
      );
      setDetail(r.consignment);
      toast.success(
        action === "accept"
          ? `Agreed at ${formatINR(r.consignment.agreed_rate_per_battery)} per battery`
          : action === "counter"
            ? "Your price is with iTarang"
            : "Done",
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function uploadPhotos(files: FileList | null) {
    if (!detail || !files || files.length === 0) return;
    setBusy(true);
    try {
      const form = new FormData();
      for (const f of Array.from(files)) form.append("file", f);
      form.append("label", "lot");
      const res = await fetch(
        `/api/nbfc/scrap/consignments/${detail.id}/photos`,
        { method: "POST", body: form },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        throw new Error(
          (typeof body?.error === "string" ? body.error : `HTTP ${res.status}`)
            .replace(/^[A-Z_]+:\s*/, ""),
        );
      }
      toast.success(`${body.uploaded} photograph(s) added`);
      const r = await api<{ consignment: ConsignmentView }>(
        `/api/nbfc/scrap/consignments/${detail.id}`,
      );
      setDetail(r.consignment);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const awaitingMe = rows.filter((r) => r.awaiting === "nbfc").length;
  const withThem = rows.filter((r) => r.awaiting === "admin").length;
  const sold = counts.paid ?? 0;

  return (
    <>
      <div className="auc-kpis">
        <div className="auc-kpi" data-tone={awaitingMe > 0 ? "warn" : undefined}>
          <b>{awaitingMe}</b>
          <span>Waiting on you</span>
        </div>
        <div className="auc-kpi">
          <b>{withThem}</b>
          <span>With iTarang</span>
        </div>
        <div className="auc-kpi" data-tone="live">
          <b>{sold}</b>
          <span>Sold</span>
        </div>
        <div className="auc-kpi">
          <b>{counts.draft ?? 0}</b>
          <span>Drafts</span>
        </div>
      </div>

      <div
        className="auc-toolbar"
        style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", alignItems: "center" }}
      >
        <div className="auc-tabs" role="tablist">
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
        <button
          type="button"
          className="auc-btn"
          style={{ marginInlineStart: "auto" }}
          onClick={() => (building ? setBuilding(false) : startBuilding())}
        >
          {building ? "Cancel" : "New scrap consignment"}
        </button>
      </div>

      {/* — the builder — */}
      {building ? (
        <section
          className="auc-card"
          style={{ padding: "1rem", display: "grid", gap: ".75rem", marginBlock: "1rem" }}
        >
          <div>
            <p className="auc-eyebrow">Step 1 · pick the batteries</p>
            <p className="auc-lede" style={{ margin: 0 }}>
              Everything scrapped and not already offered. {eligible.length} available.
            </p>
          </div>

          {eligible.length === 0 ? (
            <p className="auc-lede" style={{ margin: 0 }}>
              Nothing to sell — a battery appears here once its recovery row
              reaches the <strong>scrap</strong> stage or the register marks it
              scrapped.
            </p>
          ) : (
            <div style={{ maxHeight: "22rem", overflow: "auto" }}>
              <table className="auc-table">
                <thead>
                  <tr>
                    <th style={{ width: "2.5rem" }}>
                      <input
                        type="checkbox"
                        aria-label="Select all"
                        checked={picked.size === eligible.length && eligible.length > 0}
                        onChange={(e) =>
                          setPicked(
                            e.target.checked
                              ? new Set(eligible.map((b) => b.id))
                              : new Set(),
                          )
                        }
                      />
                    </th>
                    <th>Serial</th>
                    <th>Model</th>
                    <th>Where</th>
                    <th>Photos</th>
                    {/* [E-260] The price lives beside the battery it belongs
                        to. A separate pricing screen would divorce the number
                        from the serial and the photo count it is judged on. */}
                    {mode === "itemised" ? <th>Rate (₹)</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {eligible.map((b) => (
                    <tr key={b.id}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Select ${b.serial}`}
                          checked={picked.has(b.id)}
                          onChange={() => toggle(b.id)}
                        />
                      </td>
                      <td style={{ fontFamily: "var(--font-mono, monospace)" }}>
                        {b.serial}
                      </td>
                      <td>{b.model ?? "—"}</td>
                      <td>
                        {[b.warehouse, b.city].filter(Boolean).join(" · ") || "—"}
                      </td>
                      <td>
                        {b.image_urls.length > 0 ? (
                          b.image_urls.length
                        ) : (
                          <span className="auc-chip" data-tone="warn">
                            none
                          </span>
                        )}
                      </td>
                      {mode === "itemised" ? (
                        <td>
                          <input
                            className="auc-input"
                            inputMode="decimal"
                            aria-label={`Rate for ${b.serial}`}
                            // Disabled rather than hidden for an unpicked
                            // battery: the column keeps its shape, and pricing
                            // something that is not in the lot is meaningless.
                            disabled={!picked.has(b.id)}
                            value={itemRates[b.id] ?? ""}
                            onChange={(e) =>
                              setItemRates((prev) => ({
                                ...prev,
                                [b.id]: e.target.value.replace(/[^\d.]/g, ""),
                              }))
                            }
                            placeholder="0"
                            style={{ width: "7rem" }}
                          />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div>
            <p className="auc-eyebrow">Step 2 · name your price</p>

            {/* [E-260] One rate for the pile, or a rate per battery. The
                choice comes before the inputs because it decides what the
                inputs are. */}
            <div
              style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBlockEnd: ".6rem" }}
            >
              <label style={{ display: "flex", alignItems: "center", gap: ".4rem" }}>
                <input
                  type="radio"
                  name="scrap-pricing-mode"
                  checked={mode === "flat"}
                  onChange={() => setMode("flat")}
                />
                <span style={{ fontSize: ".9rem" }}>Same rate for every battery</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: ".4rem" }}>
                <input
                  type="radio"
                  name="scrap-pricing-mode"
                  checked={mode === "itemised"}
                  onChange={() => setMode("itemised")}
                />
                <span style={{ fontSize: ".9rem" }}>A price per battery</span>
              </label>
            </div>

            {mode === "flat" ? (
              <div style={{ display: "flex", gap: ".75rem", flexWrap: "wrap", alignItems: "center" }}>
                <label style={{ display: "grid", gap: ".2rem" }}>
                  <span style={{ fontSize: ".75rem", opacity: 0.75 }}>
                    Rate per battery (₹)
                  </span>
                  <input
                    className="auc-input"
                    inputMode="decimal"
                    value={rate}
                    onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ""))}
                    style={{ width: "9rem" }}
                  />
                </label>
                <span style={{ fontSize: ".9rem" }}>
                  × {picked.size} {picked.size === 1 ? "battery" : "batteries"} ={" "}
                  <strong>{formatINR(draftTotal)}</strong>
                </span>
              </div>
            ) : (
              <div style={{ display: "grid", gap: ".35rem" }}>
                <p className="auc-lede" style={{ margin: 0 }}>
                  Type each battery’s price in the <strong>Rate</strong> column
                  above. iTarang negotiates the lot total, so the breakdown is
                  your reasoning for the number you are asking.
                </p>
                <span style={{ fontSize: ".9rem" }}>
                  {pricedCount} of {picked.size} priced ={" "}
                  <strong>{formatINR(draftTotal)}</strong>
                  {unpricedCount > 0 ? (
                    <span
                      className="auc-chip"
                      data-tone="warn"
                      style={{ marginInlineStart: ".5rem" }}
                    >
                      {unpricedCount} still unpriced
                    </span>
                  ) : null}
                </span>
              </div>
            )}
          </div>

          <div>
            <p className="auc-eyebrow">Step 3 · where the money goes</p>
            <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
              <input
                className="auc-input"
                placeholder="Account holder name"
                value={payee.name}
                onChange={(e) => setPayee({ ...payee, name: e.target.value })}
              />
              <input
                className="auc-input"
                placeholder="Account number"
                value={payee.account}
                onChange={(e) => setPayee({ ...payee, account: e.target.value })}
              />
              <input
                className="auc-input"
                placeholder="IFSC"
                value={payee.ifsc}
                onChange={(e) =>
                  setPayee({ ...payee, ifsc: e.target.value.toUpperCase() })
                }
                style={{ width: "10rem" }}
              />
            </div>
            {ifscTyped && !ifscOk ? (
              <p className="auc-lede" style={{ margin: ".35rem 0 0", color: "#b42318" }}>
                {payee.ifsc.trim().length} of 11 characters — an IFSC is 4
                letters, then a 0, then 6 more (e.g. MAHB0000452).
              </p>
            ) : null}
            <p className="auc-lede" style={{ margin: ".35rem 0 0" }}>
              Needed before iTarang can pay, but it can be filled in later — it
              does not hold up the price conversation.
            </p>
          </div>

          <textarea
            className="auc-input"
            rows={2}
            placeholder="Anything iTarang should know — condition, quantity of casings, pickup constraints"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          {picked.size > 0 && pickedPhotos === 0 ? (
            <p className="auc-lede" style={{ margin: 0 }}>
              None of the selected batteries has a photograph. Save the draft,
              then add lot photographs before sending — iTarang prices these
              from the pictures.
            </p>
          ) : null}

          <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
            <button
              type="button"
              className="auc-btn"
              disabled={
                busy ||
                picked.size === 0 ||
                (mode === "flat"
                  ? !(Number(rate) > 0)
                  : unpricedCount > 0 || pricedCount === 0) ||
                pickedPhotos === 0 ||
                (ifscTyped && !ifscOk)
              }
              onClick={() => void createDraft(true)}
              title={
                pickedPhotos === 0
                  ? "Add at least one photograph first"
                  : mode === "itemised" && unpricedCount > 0
                    ? `${unpricedCount} battery(s) still have no price`
                    : ifscTyped && !ifscOk
                      ? "Fix the IFSC first"
                      : undefined
              }
            >
              Send to iTarang
            </button>
            <button
              type="button"
              className="auc-btn"
              data-variant="ghost"
              disabled={busy || picked.size === 0 || (ifscTyped && !ifscOk)}
              onClick={() => void createDraft(false)}
            >
              Save as draft
            </button>
          </div>
        </section>
      ) : null}

      {/* — the ledger — */}
      {error ? (
        <p className="auc-lede">{error}</p>
      ) : loading ? (
        <p className="auc-lede">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="auc-lede">Nothing here yet.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="auc-table">
            <thead>
              <tr>
                <th>Ref</th>
                <th>Batteries</th>
                <th>Your ask</th>
                <th>On the table</th>
                <th>Status</th>
                <th>Waiting on</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ fontFamily: "var(--font-mono, monospace)" }}>
                    {r.ref_code}
                  </td>
                  <td>{r.battery_count}</td>
                  <td>
                    {/* [E-260] An itemised lot has no single rate, so the
                        column shows what was actually asked for the pile. */}
                    {r.pricing_mode === "itemised" ? (
                      <>
                        {formatINR(r.asking_amount ?? null)}{" "}
                        <span style={{ fontSize: ".75rem", opacity: 0.7 }}>
                          for the lot
                        </span>
                      </>
                    ) : (
                      formatINR(r.asking_rate_per_battery)
                    )}
                  </td>
                  <td>
                    {formatINR(r.agreed_rate_per_battery ?? null)}
                    {r.agreed_amount != null ? (
                      <span style={{ opacity: 0.7 }}> · {formatINR(r.agreed_amount)}</span>
                    ) : null}
                  </td>
                  <td>
                    <span className="auc-chip" data-tone={r.status === "paid" || r.status === "agreed" ? "live" : r.status === "submitted" || r.status === "negotiating" ? "warn" : "muted"}>
                      {r.status}
                    </span>
                  </td>
                  <td>
                    {r.awaiting === "nbfc"
                      ? "you"
                      : r.awaiting === "admin"
                        ? "iTarang"
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
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* — the open deal — */}
      {detail ? (
        <div style={{ marginBlockStart: "1rem", display: "grid", gap: ".75rem" }}>
          <ConsignmentDetail
            consignment={detail}
            side="nbfc"
            busy={busy}
            onAction={act}
          />
          {detail.status === "draft" || detail.status === "submitted" || detail.status === "negotiating" ? (
            <div className="auc-card" style={{ padding: "1rem", display: "grid", gap: ".5rem" }}>
              <p className="auc-eyebrow">Add lot photographs</p>
              <input
                type="file"
                accept="image/*"
                multiple
                disabled={busy}
                onChange={(e) => void uploadPhotos(e.target.files)}
              />
              <p className="auc-lede" style={{ margin: 0 }}>
                The pile, the weighbridge slip, anything that shows what is being
                sold. Per-battery shots live on the battery register.
              </p>
              {detail.status === "draft" ? (
                <div>
                  <button
                    type="button"
                    className="auc-btn"
                    disabled={busy}
                    onClick={() => void act("submit", {})}
                  >
                    Send to iTarang
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
