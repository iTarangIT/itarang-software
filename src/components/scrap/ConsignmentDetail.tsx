"use client";

/**
 * E-258 — one scrap consignment, rendered for whichever side is looking.
 *
 * ONE COMPONENT, TWO DASHBOARDS. The NBFC and iTarang are looking at the same
 * deal from opposite ends: same photographs, same batteries, same rounds, same
 * arithmetic. The only things that differ are which buttons are live and whose
 * name is on which side of the thread. Two components would have meant two
 * copies of the rate maths and two chances for them to disagree about what the
 * current price is — which is the one thing a negotiation screen must never do.
 *
 * WHY THE THREAD IS THE CENTRE OF THE SCREEN. A rate on its own is not a
 * decision; "they came down twice and we are ₹500 apart" is. So the rounds are
 * shown in full, in order, with the delta from the previous rate, rather than
 * being collapsed into a single "current price" field.
 */
import { useState } from "react";
import { formatINR } from "@/components/auction/AuctionPrimitives";

export interface ConsignmentItemView {
  id: string;
  battery_id: string | null;
  serial: string;
  model: string | null;
  capacity: string | null;
  soh_pct: number | null;
  condition_note: string | null;
  /** [E-260] This battery's own price. NULL in flat mode. */
  asking_rate?: number | null;
  /** [E-261] Its share of the settled deal, when the accepted round had one. */
  agreed_rate?: number | null;
  image_urls: string[];
}

/** [E-261] One battery's line in an itemised round. */
export interface OfferItemRateView {
  item_id: string;
  battery_id: string | null;
  serial: string;
  rate: number;
}

export interface ConsignmentOfferView {
  id: string;
  round: number;
  /** [E-261] How this round was expressed. */
  pricing_mode?: "lot" | "itemised";
  /** [E-261] Populated only on an itemised round; sums to `amount`. */
  item_rates?: OfferItemRateView[];
  party: "nbfc" | "admin";
  kind: "quote" | "counter" | "accept" | "reject" | "withdraw";
  rate_per_battery: number | null;
  battery_count: number | null;
  amount: number | null;
  message: string | null;
  created_at: string;
}

export interface ConsignmentView {
  id: string;
  ref_code: string;
  tenant_id: string;
  tenant_name: string | null;
  status: string;
  battery_count: number;
  /** [E-260] 'flat' = one rate for the lot; 'itemised' = a rate per battery. */
  pricing_mode?: "flat" | "itemised";
  /** NULL on an itemised lot — there is no single rate to state. */
  asking_rate_per_battery: number | null;
  /** [E-260] The asking total. Set in both modes; what the deal runs on. */
  asking_amount?: number | null;
  agreed_rate_per_battery: number | null;
  agreed_amount: number | null;
  current_round: number;
  last_party: "nbfc" | "admin" | null;
  awaiting: "nbfc" | "admin" | null;
  pickup_city: string | null;
  pickup_state: string | null;
  warehouse: string | null;
  photo_urls: string[];
  note: string | null;
  payee_name: string | null;
  payee_account_number: string | null;
  payee_ifsc: string | null;
  payment_status: string;
  payment_provider: string | null;
  payment_ref: string | null;
  payment_utr: string | null;
  payment_failure_reason: string | null;
  paid_at: string | null;
  /** [E-259] Set when the batteries reached iTarang; gates a post-lot payout. */
  received_at: string | null;
  submitted_at: string | null;
  agreed_at: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
  /**
   * OPTIONAL because the same type describes a LIST row, which carries the deal
   * but not its contents. The list and the detail disagreeing about the current
   * rate is the one bug this feature cannot afford, so both read it through
   * `rateOnTable()` — which is written to work with or without the rounds.
   */
  items?: ConsignmentItemView[];
  offers?: ConsignmentOfferView[];
}

export type ScrapAction =
  | "submit"
  | "counter"
  | "accept"
  | "reject"
  | "withdraw"
  | "mark-received"
  | "pay"
  | "refresh-payment"
  | "record-offline-payment";

interface Props {
  consignment: ConsignmentView;
  /** Which end of the deal this screen is. */
  side: "nbfc" | "admin";
  /**
   * Split on the admin side, where pricing a lot and paying for it are
   * different permissions: business_head and sales_head may haggle, only
   * admin/ceo may release the money. The NBFC side leaves both at true — an
   * NBFC negotiating its own scrap is not a second decision.
   */
  canNegotiate?: boolean;
  canPay?: boolean;
  /**
   * [E-259] The NBFC's scrap payment term. 'post_lot' blocks the payout until
   * the batteries are marked received; 'pre_lot' pays on agreement. Passed in
   * rather than fetched here because the admin GET already returns it and the
   * NBFC side reads it from its own endpoint.
   */
  paymentTiming?: "pre_lot" | "post_lot";
  /** False when the term shown is the default, not one anybody chose. */
  paymentTimingIsSet?: boolean;
  busy?: boolean;
  onAction: (
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
  ) => void | Promise<void>;
}

const STATUS_TONE: Record<string, string> = {
  draft: "muted",
  submitted: "warn",
  negotiating: "warn",
  agreed: "live",
  paid: "live",
  rejected: "muted",
  withdrawn: "muted",
};

const PARTY_LABEL = (
  party: "nbfc" | "admin",
  tenantName: string | null,
): string => (party === "admin" ? "iTarang" : (tenantName ?? "NBFC"));

const KIND_VERB: Record<ConsignmentOfferView["kind"], string> = {
  quote: "offered",
  counter: "countered",
  accept: "accepted",
  reject: "declined",
  withdraw: "withdrew",
};

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

/** The rate currently on the table — the last one anybody actually named. */
/**
 * [E-260] The TOTAL on the table — the number both modes actually negotiate.
 *
 * `rateOnTable` still answers the per-battery question for flat lots, where
 * that is what the two sides say to each other; this is the figure the deal is
 * settled in and the only one an itemised lot has.
 */
export function amountOnTable(c: ConsignmentView): number | null {
  if (c.agreed_amount != null) return c.agreed_amount;
  const offers = c.offers ?? [];
  for (let i = offers.length - 1; i >= 0; i--) {
    if (offers[i].amount != null) return offers[i].amount;
  }
  if (c.asking_amount != null) return c.asking_amount;
  const rate = rateOnTable(c);
  return rate != null ? rate * c.battery_count : null;
}

export function rateOnTable(c: ConsignmentView): number | null {
  if (c.agreed_rate_per_battery != null) return c.agreed_rate_per_battery;
  const offers = c.offers ?? [];
  for (let i = offers.length - 1; i >= 0; i--) {
    if (offers[i].rate_per_battery != null) return offers[i].rate_per_battery;
  }
  return c.asking_rate_per_battery;
}

export default function ConsignmentDetail({
  consignment: c,
  side,
  canNegotiate = true,
  canPay = true,
  paymentTiming = "post_lot",
  paymentTimingIsSet = false,
  busy = false,
  onAction,
}: Props) {
  const [rate, setRate] = useState("");
  // [E-261] How THIS counter is being written — independent of how the lot was
  // priced. Either side may answer a per-battery ask with one number, or a
  // flat ask battery by battery; the disagreement is usually about one pack.
  const [counterMode, setCounterMode] = useState<"lot" | "itemised">("lot");
  const [itemDraft, setItemDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [reference, setReference] = useState("");
  const [showOffline, setShowOffline] = useState(false);

  const items = c.items ?? [];
  const offers = c.offers ?? [];
  const itemised = c.pricing_mode === "itemised";
  // [E-261] True once the deal was settled on a per-battery breakdown.
  const anyAgreedRate = (c.items ?? []).some((i) => i.agreed_rate != null);
  const table = rateOnTable(c);
  const tableTotal = amountOnTable(c);
  const myTurn = c.awaiting === side;
  const open = !["paid", "rejected", "withdrawn"].includes(c.status);
  const negotiable = open && c.status !== "draft" && c.status !== "agreed";
  // [E-261] The per-battery draft, and what it adds up to.
  const itemDraftTotal = items.reduce((sum, i) => {
    const n = Number(itemDraft[i.id]);
    return Number.isFinite(n) && n > 0 ? sum + n : sum;
  }, 0);
  const itemDraftPriced = items.filter((i) => Number(itemDraft[i.id]) > 0).length;
  const itemDraftReady = items.length > 0 && itemDraftPriced === items.length;

  const counterTotal =
    counterMode === "itemised"
      ? itemDraftTotal > 0
        ? itemDraftTotal
        : null
      : Number(rate) > 0
        ? itemised
          ? Number(rate)
          : Number(rate) * c.battery_count
        : null;

  /**
   * [E-261] Seeds the per-battery boxes from the numbers already on the table
   * — the last itemised round, or each battery's asking rate — so switching to
   * battery-by-battery starts from what is being argued about rather than from
   * an empty grid the user has to retype.
   */
  function seedItemDraft() {
    const lastItemised = [...offers]
      .reverse()
      .find((o) => (o.item_rates?.length ?? 0) > 0);
    const seeded: Record<string, string> = {};
    for (const i of items) {
      const fromRound = lastItemised?.item_rates?.find((r) => r.item_id === i.id);
      const v = fromRound?.rate ?? i.asking_rate ?? table ?? null;
      if (v != null) seeded[i.id] = String(v);
    }
    setItemDraft(seeded);
  }
  const canCounter = negotiable && canNegotiate;
  // [E-259] Under a post-lot term the money waits on the batteries arriving.
  const awaitsArrival = paymentTiming === "post_lot" && !c.received_at;
  const canReceive =
    side === "admin" && c.status === "agreed" && !c.received_at && canNegotiate;
  const canSettle = side === "admin" && c.status === "agreed" && canPay;
  const awaitingPayment = side === "nbfc" && c.status === "agreed";
  const hasMove = canCounter || canReceive || canSettle || awaitingPayment;

  // Photographs from every source in one gallery: the lot shots the NBFC took
  // for this consignment, plus each battery's own inspection photos. The buyer
  // is pricing what it can see, so hiding either behind a tab would be hiding
  // half the offer.
  const gallery = [
    ...c.photo_urls,
    ...items.flatMap((i) => i.image_urls),
  ].slice(0, 24);

  async function act(action: ScrapAction) {
    const payload: {
      rate_per_battery?: number;
      /** [E-260] The countered total, on an itemised lot. */
      amount?: number;
      /** [E-261] item_id → rate, when countering battery by battery. */
      item_rates?: Record<string, number>;
      message?: string;
      reference?: string;
    } = {};
    if (action === "counter") {
      if (counterMode === "itemised") {
        // [E-261] Every battery has to carry a number: a partial breakdown
        // sums to a total that covers only part of the lot, and the other side
        // cannot see which part.
        if (!itemDraftReady) return;
        payload.item_rates = Object.fromEntries(
          items.map((i) => [i.id, Number(itemDraft[i.id])]),
        );
      } else {
        const n = Number(rate);
        if (!Number.isFinite(n) || n <= 0) return;
        // [E-260] The same box means different things by lot: a rate per
        // battery on a flat lot, a total for the pile on an itemised one.
        if (itemised) payload.amount = n;
        else payload.rate_per_battery = n;
      }
    }
    if (action === "record-offline-payment") {
      if (!reference.trim()) return;
      payload.reference = reference.trim();
    }
    if (message.trim()) payload.message = message.trim();
    await onAction(action, payload);
    setRate("");
    setItemDraft({});
    setMessage("");
    setReference("");
  }

  return (
    <div className="auc-card" style={{ display: "grid", gap: "1.25rem", padding: "1rem" }}>
      {/* — who, what, where it stands — */}
      <header style={{ display: "grid", gap: ".35rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: ".5rem", flexWrap: "wrap" }}>
          <strong style={{ fontFamily: "var(--font-mono, monospace)" }}>{c.ref_code}</strong>
          <span className="auc-chip" data-tone={STATUS_TONE[c.status] ?? "muted"}>
            {c.status}
          </span>
          {c.awaiting ? (
            <span className="auc-chip" data-tone={myTurn ? "warn" : "muted"}>
              {myTurn
                ? "your move"
                : `waiting on ${PARTY_LABEL(c.awaiting, c.tenant_name)}`}
            </span>
          ) : null}
          {c.payment_status !== "unpaid" ? (
            <span
              className="auc-chip"
              data-tone={
                c.payment_status === "paid"
                  ? "live"
                  : c.payment_status === "failed"
                    ? "warn"
                    : "muted"
              }
            >
              payment {c.payment_status}
            </span>
          ) : null}
        </div>
        <p className="auc-lede" style={{ margin: 0 }}>
          {c.battery_count} scrap {c.battery_count === 1 ? "battery" : "batteries"}
          {side === "admin" && c.tenant_name ? ` from ${c.tenant_name}` : ""}
          {c.pickup_city || c.pickup_state
            ? ` · ${[c.pickup_city, c.pickup_state].filter(Boolean).join(", ")}`
            : ""}
          {c.warehouse ? ` · ${c.warehouse}` : ""}
        </p>
        {c.note ? (
          <p style={{ margin: 0, fontSize: ".85rem", opacity: 0.8 }}>{c.note}</p>
        ) : null}
      </header>

      {/* — the arithmetic, stated once — */}
      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(8rem, 1fr))",
          gap: "1px",
          background: "var(--auc-rule)",
          border: "1px solid var(--auc-rule)",
          margin: 0,
        }}
      >
        {/* [E-260] An itemised lot has no per-battery figure to state, so the
            two rate cells give way to the totals the deal actually runs on. */}
        <Cell
          label="NBFC asking"
          value={formatINR(itemised ? c.asking_amount ?? null : c.asking_rate_per_battery)}
          sub={itemised ? "for the lot" : "per battery"}
        />
        <Cell
          label={
            c.agreed_amount != null
              ? itemised
                ? "Agreed"
                : "Agreed rate"
              : "On the table"
          }
          value={formatINR(itemised ? tableTotal : table)}
          sub={itemised ? "for the lot" : "per battery"}
          tone={c.agreed_amount != null ? "live" : undefined}
        />
        <Cell
          label="Batteries"
          value={String(c.battery_count)}
          sub={itemised ? "priced individually" : undefined}
        />
        <Cell
          label={c.agreed_amount != null ? "Deal value" : "At this price"}
          value={formatINR(c.agreed_amount ?? tableTotal)}
          tone={c.agreed_amount != null ? "live" : undefined}
        />
      </dl>

      {/* — the photographs the price is based on — */}
      {gallery.length > 0 ? (
        <section>
          <p className="auc-eyebrow">Photographs ({gallery.length})</p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(6rem, 1fr))",
              gap: ".5rem",
            }}
          >
            {gallery.map((src) => (
              <a key={src} href={src} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src}
                  alt=""
                  loading="lazy"
                  style={{
                    width: "100%",
                    aspectRatio: "1",
                    objectFit: "cover",
                    border: "1px solid var(--auc-rule)",
                  }}
                />
              </a>
            ))}
          </div>
        </section>
      ) : (
        <p className="auc-lede" style={{ margin: 0 }}>
          No photographs attached yet — iTarang prices these from the pictures.
        </p>
      )}

      {/* — what is actually in the lot — */}
      <section>
        <p className="auc-eyebrow">Batteries in this lot</p>
        <div style={{ overflowX: "auto" }}>
          <table className="auc-table">
            <thead>
              <tr>
                <th>Serial</th>
                <th>Model</th>
                <th>Capacity</th>
                <th>SOH</th>
                <th>Photos</th>
                {itemised ? <th>NBFC price</th> : null}
                {/* [E-261] Only once a deal was struck battery by battery.
                    A lot-level acceptance leaves no per-battery split, and
                    the column is absent rather than full of dashes. */}
                {anyAgreedRate ? <th>Agreed</th> : null}
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td style={{ fontFamily: "var(--font-mono, monospace)" }}>{i.serial}</td>
                  <td>{i.model ?? "—"}</td>
                  <td>{i.capacity ?? "—"}</td>
                  <td>{i.soh_pct != null ? `${i.soh_pct}%` : "—"}</td>
                  <td>{i.image_urls.length || "—"}</td>
                  {itemised ? <td>{formatINR(i.asking_rate ?? null)}</td> : null}
                  {anyAgreedRate ? (
                    <td>
                      <strong>{formatINR(i.agreed_rate ?? null)}</strong>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* — the negotiation, in full — */}
      <section>
        <p className="auc-eyebrow">Negotiation</p>
        {offers.length === 0 ? (
          <p className="auc-lede" style={{ margin: 0 }}>
            Nothing has been offered yet.
          </p>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: ".5rem" }}>
            {offers.map((o, idx) => {
              const prev = [...offers]
                .slice(0, idx)
                .reverse()
                .find((p) => (itemised ? p.amount != null : p.rate_per_battery != null));
              const delta = itemised
                ? o.amount != null && prev?.amount != null
                  ? o.amount - prev.amount
                  : null
                : o.rate_per_battery != null && prev?.rate_per_battery != null
                  ? o.rate_per_battery - prev.rate_per_battery
                  : null;
              const mine = o.party === side;
              return (
                <li
                  key={o.id}
                  style={{
                    border: "1px solid var(--auc-rule)",
                    padding: ".6rem .75rem",
                    background: mine ? "transparent" : "rgba(127,127,127,.06)",
                  }}
                >
                  <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", alignItems: "baseline" }}>
                    <strong>{PARTY_LABEL(o.party, c.tenant_name)}</strong>
                    <span style={{ opacity: 0.75 }}>{KIND_VERB[o.kind]}</span>
                    {o.rate_per_battery != null ? (
                      <span>
                        <strong>{formatINR(o.rate_per_battery)}</strong> per battery ·{" "}
                        {formatINR(o.amount)}
                      </span>
                    ) : o.amount != null ? (
                      <span>
                        <strong>{formatINR(o.amount)}</strong> for the lot
                      </span>
                    ) : null}
                    {delta != null && delta !== 0 ? (
                      <span
                        className="auc-chip"
                        data-tone={delta < 0 ? "muted" : "warn"}
                      >
                        {delta > 0 ? "+" : ""}
                        {formatINR(Math.abs(delta)).replace("₹", delta < 0 ? "−₹" : "₹")}
                      </span>
                    ) : null}
                    <span style={{ marginLeft: "auto", fontSize: ".75rem", opacity: 0.7 }}>
                      round {o.round} · {when(o.created_at)}
                    </span>
                  </div>
                  {/* [E-261] The breakdown behind an itemised round, folded
                      away: the headline is the total, and the per-battery
                      detail is what you open when you want to argue about one
                      pack. */}
                  {(o.item_rates?.length ?? 0) > 0 ? (
                    <details style={{ marginBlockStart: ".35rem" }}>
                      <summary style={{ cursor: "pointer", fontSize: ".8rem", opacity: 0.85 }}>
                        Per-battery breakdown ({o.item_rates!.length})
                      </summary>
                      <ul
                        style={{
                          listStyle: "none",
                          margin: ".3rem 0 0",
                          padding: 0,
                          display: "grid",
                          gap: ".15rem",
                          fontSize: ".8rem",
                        }}
                      >
                        {o.item_rates!.map((r) => (
                          <li
                            key={r.item_id}
                            style={{ display: "flex", gap: ".5rem" }}
                          >
                            <span style={{ fontFamily: "var(--font-mono, monospace)" }}>
                              {r.serial}
                            </span>
                            <span style={{ marginInlineStart: "auto" }}>
                              {formatINR(r.rate)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {o.message ? (
                    <p style={{ margin: ".35rem 0 0", fontSize: ".85rem" }}>{o.message}</p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* — the payment, once there is one to talk about — */}
      {(c.status === "agreed" || c.status === "paid" || c.payment_status !== "unpaid") ? (
        <section>
          <p className="auc-eyebrow">Payment</p>
          <p style={{ margin: 0, fontSize: ".9rem" }}>
            {c.payment_status === "paid" ? (
              <>
                {formatINR(c.agreed_amount)} paid
                {c.payment_provider ? ` by ${c.payment_provider === "razorpayx" ? "RazorpayX" : "bank transfer"}` : ""}
                {c.payment_utr ? ` · UTR ${c.payment_utr}` : c.payment_ref ? ` · ref ${c.payment_ref}` : ""}
                {c.paid_at ? ` · ${when(c.paid_at)}` : ""}
              </>
            ) : c.payment_status === "processing" ? (
              <>
                A payout of {formatINR(c.agreed_amount)} is in flight
                {c.payment_ref ? ` (${c.payment_ref})` : ""}. The batteries transfer
                once the bank confirms it.
              </>
            ) : c.payment_status === "failed" ? (
              <>
                The last payout failed
                {c.payment_failure_reason ? `: ${c.payment_failure_reason}` : "."}
              </>
            ) : (
              <>{formatINR(c.agreed_amount)} is due to {c.tenant_name ?? "the NBFC"}.</>
            )}
          </p>
          {c.payee_name || c.payee_account_number ? (
            <p style={{ margin: ".35rem 0 0", fontSize: ".8rem", opacity: 0.8 }}>
              Payee: {c.payee_name ?? "—"} ·{" "}
              {c.payee_account_number
                ? `A/C ••••${c.payee_account_number.slice(-4)}`
                : "no account"}{" "}
              · {c.payee_ifsc ?? "no IFSC"}
            </p>
          ) : (
            <p style={{ margin: ".35rem 0 0", fontSize: ".8rem" }} className="auc-lede">
              No payee bank details on this consignment yet — the NBFC has to add
              them before a payout can be sent.
            </p>
          )}
        </section>
      ) : null}

      {/* — what this viewer can do about it — */}
      {hasMove && open ? (
        <section style={{ display: "grid", gap: ".6rem" }}>
          <p className="auc-eyebrow">Your move</p>

          {canCounter ? (
            <>
              <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap", alignItems: "center" }}>
                {/* [E-261] How to answer: one number, or battery by battery. Offered on
                    every lot regardless of how it was first priced — the point is to be
                    able to say WHICH battery the disagreement is about. */}
                <div style={{ display: "flex", gap: "1rem", flexWrap: "wrap", width: "100%" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: ".4rem" }}>
                    <input
                      type="radio"
                      name={`counter-mode-${c.id}`}
                      checked={counterMode === "lot"}
                      onChange={() => setCounterMode("lot")}
                    />
                    <span style={{ fontSize: ".85rem" }}>
                      {itemised ? "One total for the lot" : "One rate for every battery"}
                    </span>
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: ".4rem" }}>
                    <input
                      type="radio"
                      name={`counter-mode-${c.id}`}
                      checked={counterMode === "itemised"}
                      onChange={() => {
                        setCounterMode("itemised");
                        // Seed only the first time in, so a half-typed grid is not
                        // overwritten by toggling back and forth.
                        if (Object.keys(itemDraft).length === 0) seedItemDraft();
                      }}
                    />
                    <span style={{ fontSize: ".85rem" }}>Price each battery</span>
                  </label>
                </div>

                {counterMode === "lot" ? (
                  <>
                    <label style={{ display: "grid", gap: ".2rem" }}>
                      <span style={{ fontSize: ".75rem", opacity: 0.75 }}>
                        {itemised ? "Total for the lot (₹)" : "Rate per battery (₹)"}
                      </span>
                      <input
                        className="auc-input"
                        inputMode="decimal"
                        value={rate}
                        onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ""))}
                        placeholder={String((itemised ? tableTotal : table) ?? 0)}
                        style={{ width: itemised ? "11rem" : "9rem" }}
                      />
                    </label>
                    {counterTotal != null ? (
                      <span style={{ fontSize: ".85rem", opacity: 0.8 }}>
                        {itemised ? (
                          <>
                            for {c.battery_count}{" "}
                            {c.battery_count === 1 ? "battery" : "batteries"}
                          </>
                        ) : (
                          <>
                            × {c.battery_count} = <strong>{formatINR(counterTotal)}</strong>
                          </>
                        )}
                      </span>
                    ) : null}
                  </>
                ) : (
                  <div style={{ width: "100%", display: "grid", gap: ".4rem" }}>
                    <div style={{ overflowX: "auto" }}>
                      <table className="auc-table">
                        <thead>
                          <tr>
                            <th>Serial</th>
                            <th>SOH</th>
                            <th>On the table</th>
                            <th>Your price (₹)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {items.map((i) => {
                            const lastItemised = [...offers]
                              .reverse()
                              .find((o) => (o.item_rates?.length ?? 0) > 0);
                            const standing =
                              lastItemised?.item_rates?.find((r) => r.item_id === i.id)?.rate ??
                              i.asking_rate ??
                              null;
                            return (
                              <tr key={i.id}>
                                <td style={{ fontFamily: "var(--font-mono, monospace)" }}>
                                  {i.serial}
                                </td>
                                <td>{i.soh_pct != null ? `${i.soh_pct}%` : "—"}</td>
                                <td>{formatINR(standing)}</td>
                                <td>
                                  <input
                                    className="auc-input"
                                    inputMode="decimal"
                                    aria-label={`Your price for ${i.serial}`}
                                    value={itemDraft[i.id] ?? ""}
                                    onChange={(e) =>
                                      setItemDraft((prev) => ({
                                        ...prev,
                                        [i.id]: e.target.value.replace(/[^\d.]/g, ""),
                                      }))
                                    }
                                    placeholder={standing != null ? String(standing) : "0"}
                                    style={{ width: "7.5rem" }}
                                  />
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <span style={{ fontSize: ".85rem" }}>
                      {itemDraftPriced} of {items.length} priced ={" "}
                      <strong>{formatINR(counterTotal)}</strong>
                      {!itemDraftReady ? (
                        <span
                          className="auc-chip"
                          data-tone="warn"
                          style={{ marginInlineStart: ".5rem" }}
                        >
                          every battery needs a price
                        </span>
                      ) : null}
                    </span>
                  </div>
                )}
              </div>
              <textarea
                className="auc-input"
                rows={2}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Optional note — condition, pickup, why this number"
              />
              <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="auc-btn"
                  disabled={
                    busy ||
                    !myTurn ||
                    (counterMode === "itemised"
                      ? !itemDraftReady
                      : !(Number(rate) > 0))
                  }
                  onClick={() => void act("counter")}
                  title={
                    !myTurn
                      ? "The other side has not answered yet"
                      : counterMode === "itemised" && !itemDraftReady
                        ? "Every battery needs a price"
                        : undefined
                  }
                >
                  {offers.length === 0 ? "Send price" : "Counter"}
                </button>
                <button
                  type="button"
                  className="auc-btn"
                  data-variant="ghost"
                  disabled={busy || !myTurn || (itemised ? tableTotal : table) == null}
                  onClick={() => void act("accept")}
                  title={
                    myTurn
                      ? itemised
                        ? `Accept ${formatINR(tableTotal)} for the lot`
                        : `Accept ${formatINR(table)} per battery`
                      : "Not your turn"
                  }
                >
                  {itemised
                    ? `Accept ${formatINR(tableTotal)}`
                    : `Accept ${formatINR(table)}/battery`}
                </button>
                <button
                  type="button"
                  className="auc-btn"
                  data-variant="ghost"
                  disabled={busy}
                  onClick={() => void act("reject")}
                >
                  Decline
                </button>
                {side === "nbfc" ? (
                  <button
                    type="button"
                    className="auc-btn"
                    data-variant="ghost"
                    disabled={busy}
                    onClick={() => void act("withdraw")}
                  >
                    Withdraw
                  </button>
                ) : null}
              </div>
            </>
          ) : null}

          {/* [E-259] The arrival the post-lot term waits on. Offered even
              under a pre-lot term, where it gates nothing: paid-on / arrived-on
              is the pair of dates a reconciliation needs either way. */}
          {canReceive ? (
            <div className="rounded border border-slate-200 p-2">
              <p className="auc-lede" style={{ margin: "0 0 .4rem" }}>
                {awaitsArrival
                  ? "This NBFC is paid after the lot arrives — the payout unlocks once the batteries are here."
                  : "This NBFC is paid before the lot arrives, so recording the arrival is for the record only."}
              </p>
              <button
                type="button"
                className="auc-btn"
                data-variant={awaitsArrival ? undefined : "ghost"}
                disabled={busy}
                onClick={() => void act("mark-received")}
              >
                Mark {c.battery_count}{" "}
                {c.battery_count === 1 ? "battery" : "batteries"} received
              </button>
            </div>
          ) : null}

          {c.received_at ? (
            <p className="auc-lede" style={{ margin: 0 }}>
              Batteries received at iTarang on {when(c.received_at)}.
            </p>
          ) : null}

          {/* The money leg is iTarang's alone, and admin/ceo's within it. */}
          {canSettle ? (
            <div style={{ display: "grid", gap: ".5rem" }}>
              <div style={{ display: "flex", gap: ".5rem", flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="auc-btn"
                  disabled={
                    busy || c.payment_status === "processing" || awaitsArrival
                  }
                  onClick={() => void act("pay")}
                  title={
                    awaitsArrival
                      ? "Post-lot terms — mark the batteries received first"
                      : undefined
                  }
                >
                  Pay {formatINR(c.agreed_amount)} &amp; take the lot
                </button>
                {c.payment_status === "processing" ? (
                  <button
                    type="button"
                    className="auc-btn"
                    data-variant="ghost"
                    disabled={busy}
                    onClick={() => void act("refresh-payment")}
                  >
                    Check payout status
                  </button>
                ) : null}
                <button
                  type="button"
                  className="auc-btn"
                  data-variant="ghost"
                  disabled={busy || awaitsArrival}
                  onClick={() => setShowOffline((v) => !v)}
                  title={
                    awaitsArrival
                      ? "Post-lot terms — mark the batteries received first"
                      : undefined
                  }
                >
                  Paid by bank transfer
                </button>
              </div>
              {awaitsArrival ? (
                <p className="auc-lede" style={{ margin: 0 }}>
                  Payment is held until the batteries reach iTarang —{" "}
                  {paymentTimingIsSet
                    ? "this NBFC is on post-lot terms"
                    : "no term is set for this NBFC, so the post-lot default applies"}
                  . Change it in Settings → NBFC → Payments.
                </p>
              ) : null}
              {showOffline ? (
                <div style={{ display: "grid", gap: ".4rem" }}>
                  <input
                    className="auc-input"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    placeholder="UTR or bank reference"
                  />
                  <textarea
                    className="auc-input"
                    rows={2}
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="Optional note — which account, who authorised it"
                  />
                  <div>
                    <button
                      type="button"
                      className="auc-btn"
                      disabled={busy || reference.trim().length < 3}
                      onClick={() => void act("record-offline-payment")}
                    >
                      Record payment of {formatINR(c.agreed_amount)}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {awaitingPayment ? (
            <p className="auc-lede" style={{ margin: 0 }}>
              The rate is agreed. iTarang pays {formatINR(c.agreed_amount)} and
              collects the batteries — you will be notified the moment the money
              is sent.
            </p>
          ) : null}
        </section>
      ) : null}

      {!canNegotiate && !canPay ? (
        <p className="auc-lede" style={{ margin: 0 }}>
          You can see this deal but not price or pay for it.
        </p>
      ) : null}

      {/*
        The agreed-but-unpayable case. Without this the screen simply ends
        after an accepted rate and reads as finished, when what it is actually
        waiting on is a person with a different role.
      */}
      {canNegotiate && !canPay && side === "admin" && c.status === "agreed" ? (
        <p className="auc-lede" style={{ margin: 0 }}>
          Agreed at {formatINR(c.agreed_rate_per_battery)} per battery —{" "}
          {formatINR(c.agreed_amount)} in total. Releasing the payment is an
          admin or CEO action; they have been notified.
        </p>
      ) : null}
    </div>
  );
}

function Cell({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "live" | "warn";
}) {
  return (
    <div style={{ background: "var(--auc-card, #fff)", padding: ".6rem .75rem" }}>
      <div style={{ fontSize: ".7rem", textTransform: "uppercase", letterSpacing: ".06em", opacity: 0.7 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: "1.05rem",
          fontWeight: 600,
          color: tone === "live" ? "var(--auc-live)" : undefined,
        }}
      >
        {value}
      </div>
      {sub ? <div style={{ fontSize: ".7rem", opacity: 0.65 }}>{sub}</div> : null}
    </div>
  );
}
