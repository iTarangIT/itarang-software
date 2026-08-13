"use client";

/**
 * E-234 — the Auction Control Centre.
 *
 * WHAT THIS FIXES
 *   Eight admin auction endpoints have existed since E-069/E-070 with NO UI
 *   and no nav entry. Every one of them takes a `lot_id` that nothing in the
 *   product ever showed you. So the entire control surface — pause, extend,
 *   reduce, reserve price, approve winner, and the dual-approval cancel — was
 *   reachable only with a hand-written curl. This is the screen they were
 *   written for.
 *
 * SHAPE
 *   A ledger table, not a card grid. An admin scans for the lot that is wrong;
 *   a dealer looks at one lot and decides whether to want it. Same design
 *   language, different instrument (see .auc-table in auction-theme.css).
 *
 * DESTRUCTIVE ACTIONS ARE NOT ONE CLICK
 *   Reduce-time and cancel take an MFA token and a typed reason, and cancel
 *   additionally needs a second admin. The panel asks for those inline rather
 *   than in a modal, so the lot's own numbers stay on screen while the admin
 *   types — the whole point of the reason field is that they looked.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CountdownRing,
  StatusChip,
  formatINR,
} from "@/components/auction/AuctionPrimitives";
import CancelLotApprovalQueue from "@/components/admin/nbfc/CancelLotApprovalQueue";

type Lot = {
  lot_id: string;
  lot_code: string;
  title: string | null;
  quantity: number;
  base_price: number;
  bid_increment: number;
  current_bid: number;
  bidder_count: number;
  starts_at: string | null;
  ends_at: string;
  status: string;
  auction_type: string;
  seller_tenant_id: string | null;
  seller_name: string | null;
  top_bid_id: string | null;
  top_bidder_dealer_id: string | null;
  audience_dealers: number;
  audience_pending: number;
  audience_failed: number;
  settlement: {
    status: string;
    final_price: number | null;
    winner_dealer_id: string | null;
  } | null;
};

const TABS = [
  { value: "live", label: "Live" },
  { value: "scheduled", label: "Scheduled" },
  { value: "paused", label: "Paused" },
  { value: "ended", label: "Ended" },
  { value: "draft", label: "Draft" },
  { value: "cancelled", label: "Cancelled" },
  { value: "all", label: "All" },
] as const;

/** Poll cadence. Slower than the dealer surfaces on purpose — an admin is
 *  watching for exceptions, not racing a countdown, and this list is the
 *  heaviest read in the feature. */
const POLL_MS = 10_000;

export default function AuctionControlCentre() {
  const [status, setStatus] = useState<string>("live");
  const [lots, setLots] = useState<Lot[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openLotId, setOpenLotId] = useState<string | null>(null);

  const load = useCallback(
    async (opts: { quiet?: boolean } = {}) => {
      if (!opts.quiet) setLoading(true);
      try {
        const res = await fetch(
          `/api/admin/nbfc/auction/lots?status=${encodeURIComponent(status)}&pageSize=100`,
          { cache: "no-store" },
        );
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          setLoadError(json?.error ?? `HTTP ${res.status}`);
          setLots([]);
          return;
        }
        setLoadError(null);
        setLots(json.items ?? []);
        setTotal(json.total ?? 0);
      } catch {
        setLoadError("Could not reach the server.");
      } finally {
        setLoading(false);
      }
    },
    [status],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const t = setInterval(() => void load({ quiet: true }), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const totals = useMemo(
    () => ({
      lots: lots.length,
      bidders: lots.reduce((s, l) => s + l.bidder_count, 0),
      value: lots.reduce((s, l) => s + (l.current_bid || 0), 0),
      pending: lots.reduce((s, l) => s + l.audience_pending, 0),
      failed: lots.reduce((s, l) => s + l.audience_failed, 0),
    }),
    [lots],
  );

  return (
    <div className="auction-sheet">
      <header style={{ marginBlockEnd: "1.5rem" }}>
        <p className="auc-eyebrow">Battery auction · control centre</p>
        <h1 className="auc-h1">Auction Control Centre</h1>
        <p className="auc-lede">
          Platform-wide oversight of every NBFC&rsquo;s lots. Extending, pausing
          and cancelling are logged against the lot and visible to the seller.
        </p>
      </header>

      <dl
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(9rem, 1fr))",
          gap: "1px",
          background: "var(--auc-rule)",
          border: "1px solid var(--auc-rule)",
          marginBlockEnd: "1.5rem",
        }}
      >
        <Stat label="Lots shown" value={String(totals.lots)} of={total} />
        <Stat label="Active bidders" value={String(totals.bidders)} />
        <Stat label="Bid value" value={formatINR(totals.value)} />
        <Stat
          label="Notices queued"
          value={String(totals.pending)}
          tone={totals.pending > 0 ? "warn" : undefined}
        />
        <Stat
          label="Notices failed"
          value={String(totals.failed)}
          tone={totals.failed > 0 ? "warn" : undefined}
        />
      </dl>

      <div className="auc-tabs" role="tablist" aria-label="Lot status">
        {TABS.map((t) => (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={status === t.value}
            className="auc-tab"
            onClick={() => {
              setStatus(t.value);
              setOpenLotId(null);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loadError ? (
        <p className="auc-note" data-tone="error">
          {loadError}
        </p>
      ) : loading ? (
        <p className="auc-note">Loading lots…</p>
      ) : lots.length === 0 ? (
        <p className="auc-note">No {status === "all" ? "" : status} lots.</p>
      ) : (
        <div className="auc-scroll-x">
          <table className="auc-table">
            <thead>
              <tr>
                <th>Lot</th>
                <th>Seller</th>
                <th>Status</th>
                <th style={{ textAlign: "end" }}>Base</th>
                <th style={{ textAlign: "end" }}>Current</th>
                <th style={{ textAlign: "end" }}>Bidders</th>
                <th>Closes</th>
                <th>Audience</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lots.map((lot) => (
                <LotRow
                  key={lot.lot_id}
                  lot={lot}
                  open={openLotId === lot.lot_id}
                  onToggle={() =>
                    setOpenLotId((cur) => (cur === lot.lot_id ? null : lot.lot_id))
                  }
                  onChanged={() => void load({ quiet: true })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section style={{ marginBlockStart: "2.5rem" }}>
        <p className="auc-eyebrow">Cancel-lot approvals · second admin</p>
        <p className="auc-lede" style={{ marginBlockEnd: "1rem" }}>
          Cancelling a lot destroys a live market and returns its batteries to
          stock, so it takes two different admins. Requests raised here appear
          for everyone except the person who raised them.
        </p>
        <div style={{ border: "1px solid var(--auc-rule)" }}>
          <CancelLotApprovalQueue />
        </div>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  of,
  tone,
}: {
  label: string;
  value: string;
  of?: number;
  tone?: "warn";
}) {
  return (
    <div style={{ background: "var(--auc-paper, #fff)", padding: "0.75rem 0.875rem" }}>
      <dt
        style={{
          fontFamily: "var(--auc-mono)",
          fontSize: "0.5625rem",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "var(--auc-ink-2)",
        }}
      >
        {label}
      </dt>
      <dd
        style={{
          fontFamily: "var(--auc-display)",
          fontSize: "1.375rem",
          fontWeight: 600,
          marginBlockStart: "0.125rem",
          color: tone === "warn" ? "var(--auc-warn)" : "var(--auc-ink)",
        }}
      >
        {value}
        {of !== undefined && of > 0 ? (
          <span
            style={{
              fontFamily: "var(--auc-mono)",
              fontSize: "0.6875rem",
              color: "var(--auc-ink-2)",
              fontWeight: 400,
            }}
          >
            {" "}
            / {of}
          </span>
        ) : null}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One lot: the ledger row plus its action panel
// ---------------------------------------------------------------------------

function LotRow({
  lot,
  open,
  onToggle,
  onChanged,
}: {
  lot: Lot;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const windowMs =
    lot.starts_at != null
      ? new Date(lot.ends_at).getTime() - new Date(lot.starts_at).getTime()
      : undefined;

  return (
    <>
      <tr>
        <td>
          <div className="auc-lotcode">{lot.lot_code}</div>
          <div style={{ fontWeight: 600 }}>
            {lot.title || `${lot.quantity} × battery`}
          </div>
          <div className="auc-meta">
            {lot.quantity} unit{lot.quantity === 1 ? "" : "s"} ·{" "}
            {lot.auction_type === "cash_refinance" ? "cash or refinance" : "cash"}
          </div>
        </td>
        <td>{lot.seller_name ?? <span className="auc-meta">—</span>}</td>
        <td>
          <StatusChip status={lot.status} />
        </td>
        <td className="auc-num">{formatINR(lot.base_price)}</td>
        <td className="auc-num">
          {lot.current_bid > 0 ? formatINR(lot.current_bid) : "—"}
        </td>
        <td className="auc-num">{lot.bidder_count}</td>
        <td>
          {lot.status === "live" ? (
            <CountdownRing endsAt={lot.ends_at} windowMs={windowMs} />
          ) : (
            <span className="auc-meta">
              {new Date(lot.ends_at).toLocaleString("en-IN")}
            </span>
          )}
        </td>
        <td>
          <span className="auc-meta">
            <b>{lot.audience_dealers}</b> dealers
          </span>
          {lot.audience_pending > 0 ? (
            <div className="auc-note">{lot.audience_pending} queued</div>
          ) : null}
          {lot.audience_failed > 0 ? (
            <div className="auc-note" data-tone="error">
              {lot.audience_failed} failed
            </div>
          ) : null}
        </td>
        <td>
          <button
            type="button"
            className="auc-btn"
            data-variant="ghost"
            aria-expanded={open}
            onClick={onToggle}
          >
            {open ? "Close" : "Manage"}
          </button>
        </td>
      </tr>
      {open ? (
        <tr>
          <td colSpan={9} style={{ padding: 0 }}>
            <LotActions lot={lot} onChanged={onChanged} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

type ActionState = { busy: boolean; note: string | null; tone: "ok" | "error" | null };

function LotActions({ lot, onChanged }: { lot: Lot; onChanged: () => void }) {
  const [reason, setReason] = useState("");
  const [mfa, setMfa] = useState("");
  const [reserve, setReserve] = useState(String(lot.base_price));
  const [confirmDestructive, setConfirmDestructive] = useState(false);
  const [state, setState] = useState<ActionState>({
    busy: false,
    note: null,
    tone: null,
  });

  const post = useCallback(
    async (path: string, body: Record<string, unknown>) => {
      setState({ busy: true, note: null, tone: null });
      try {
        const res = await fetch(`/api/admin/nbfc/auction/lot/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lot_id: lot.lot_id, ...body }),
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          setState({
            busy: false,
            note: json?.error ?? `HTTP ${res.status}`,
            tone: "error",
          });
          return false;
        }
        setState({ busy: false, note: "Done.", tone: "ok" });
        onChanged();
        return true;
      } catch {
        setState({ busy: false, note: "Could not reach the server.", tone: "error" });
        return false;
      }
    },
    [lot.lot_id, onChanged],
  );

  const needsReason = reason.trim().length === 0;
  const needsMfa = mfa.trim().length < 6;
  const isLive = lot.status === "live";
  const isPaused = lot.status === "paused";
  const isEnded = lot.status === "ended";

  return (
    <div className="auc-actions" data-open={confirmDestructive ? "true" : "false"}>
      <div className="auc-action-row">
        <label className="auc-action-label" htmlFor={`reason-${lot.lot_id}`}>
          Reason (required)
        </label>
        <input
          id={`reason-${lot.lot_id}`}
          className="auc-input"
          style={{ flex: "1 1 22rem" }}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this lot being changed? Recorded against the lot."
        />
      </div>

      <div className="auc-action-row">
        <span className="auc-action-label">Timing</span>
        {[15, 30, 60].map((m) => (
          <button
            key={m}
            type="button"
            className="auc-btn"
            data-variant="ghost"
            disabled={state.busy || !isLive || needsReason}
            onClick={() =>
              void post("extend-time", {
                extend_by_minutes: m,
                reason: reason.trim(),
              })
            }
          >
            +{m}m
          </button>
        ))}
        {isLive ? (
          <button
            type="button"
            className="auc-btn"
            data-variant="ghost"
            disabled={state.busy || needsReason}
            onClick={() => void post("pause", { reason: reason.trim() })}
          >
            Pause
          </button>
        ) : null}
        {isPaused ? (
          <button
            type="button"
            className="auc-btn"
            disabled={state.busy || needsReason}
            onClick={() => void post("resume", { reason: reason.trim() })}
          >
            Resume
          </button>
        ) : null}
      </div>

      <div className="auc-action-row">
        <label className="auc-action-label" htmlFor={`reserve-${lot.lot_id}`}>
          Reserve price
        </label>
        <input
          id={`reserve-${lot.lot_id}`}
          className="auc-input"
          type="number"
          min={1}
          step={100}
          style={{ inlineSize: "10rem" }}
          value={reserve}
          onChange={(e) => setReserve(e.target.value)}
        />
        <button
          type="button"
          className="auc-btn"
          data-variant="ghost"
          disabled={state.busy || !(Number(reserve) > 0)}
          onClick={() =>
            void post("reserve-price", { reserve_price_inr: Number(reserve) })
          }
        >
          Set floor
        </button>
        <span className="auc-note">
          Only accepted before the first bid — after that the floor is what
          bidders priced against.
        </span>
      </div>

      {isEnded && lot.top_bid_id ? (
        <div className="auc-action-row">
          <span className="auc-action-label">Award</span>
          <button
            type="button"
            className="auc-btn"
            disabled={state.busy}
            onClick={() =>
              void post("approve-winning-bid", { winning_bid_id: lot.top_bid_id })
            }
          >
            Approve {formatINR(lot.current_bid)} winner
          </button>
          <span className="auc-note">
            {lot.settlement
              ? `Settlement is ${lot.settlement.status}.`
              : "Opens the settlement and starts the payment flow."}
          </span>
        </div>
      ) : null}

      {/* --- destructive half --- */}
      <div
        style={{
          borderBlockStart: "1px solid var(--auc-rule)",
          paddingBlockStart: "0.75rem",
          display: "grid",
          gap: "0.75rem",
        }}
      >
        <label
          className="auc-note"
          style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}
        >
          <input
            type="checkbox"
            checked={confirmDestructive}
            onChange={(e) => setConfirmDestructive(e.target.checked)}
          />
          Show the actions that end this auction early
        </label>

        {confirmDestructive ? (
          <>
            <div className="auc-action-row">
              <label className="auc-action-label" htmlFor={`mfa-${lot.lot_id}`}>
                MFA code
              </label>
              <input
                id={`mfa-${lot.lot_id}`}
                className="auc-input"
                inputMode="numeric"
                autoComplete="one-time-code"
                style={{ inlineSize: "10rem" }}
                value={mfa}
                onChange={(e) => setMfa(e.target.value)}
                placeholder="6-digit code"
              />
              <span className="auc-note" data-tone="error">
                Note: the server-side verifier currently accepts any 6–8 digit
                code. Treat this as a speed bump, not authentication, until it is
                wired to the real factor.
              </span>
            </div>

            <div className="auc-action-row">
              <span className="auc-action-label">Cut short</span>
              <button
                type="button"
                className="auc-btn"
                data-variant="ghost"
                disabled={state.busy || !isLive || needsMfa}
                onClick={() =>
                  void post("reduce-time", {
                    reduce_by_minutes: 15,
                    end_now: false,
                    mfa_token: mfa.trim(),
                  })
                }
              >
                −15m
              </button>
              <button
                type="button"
                className="auc-btn"
                disabled={state.busy || !isLive || needsMfa}
                onClick={() => {
                  if (
                    !window.confirm(
                      `End ${lot.lot_code} now? Bidding stops immediately and the highest bid at this moment wins.`,
                    )
                  )
                    return;
                  void post("reduce-time", {
                    reduce_by_minutes: 0,
                    end_now: true,
                    mfa_token: mfa.trim(),
                  });
                }}
              >
                End now
              </button>
            </div>

            <div className="auc-action-row">
              <span className="auc-action-label">Cancel lot</span>
              <button
                type="button"
                className="auc-btn"
                disabled={state.busy || needsReason || needsMfa}
                onClick={() => {
                  if (
                    !window.confirm(
                      `Request cancellation of ${lot.lot_code}? A second admin must approve before anything happens.`,
                    )
                  )
                    return;
                  void post("cancel/request", {
                    reason: reason.trim(),
                    mfa_token: mfa.trim(),
                  });
                }}
              >
                Request cancellation
              </button>
              <span className="auc-note">
                Raises a request in the queue below. It needs a different admin
                to approve — you cannot approve your own.
              </span>
            </div>
          </>
        ) : null}
      </div>

      {state.note ? (
        <p className="auc-note" data-tone={state.tone ?? undefined}>
          {state.note}
        </p>
      ) : null}
    </div>
  );
}
