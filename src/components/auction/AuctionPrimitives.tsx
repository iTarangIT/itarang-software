"use client";

/**
 * E-234 — shared auction UI primitives.
 *
 * These render the design language in src/app/auction-theme.css. The CSS holds
 * the appearance; these hold only the small amount of logic that CSS genuinely
 * cannot do — counting down, and deciding which urgency band a deadline is in.
 *
 * Everything visual is expressed as a `data-*` attribute so the stylesheet can
 * react with `:has()` and attribute selectors, rather than components passing
 * className variants around. That is why a card can restyle its own top rule
 * from the state of a ring nested two levels inside it.
 */
import { useEffect, useMemo, useRef, useState } from "react";

export const RUPEE = "₹";

export function formatINR(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `${RUPEE}${Math.round(n).toLocaleString("en-IN")}`;
}

/** Compact form for tight card slots: ₹1.84L, ₹1.2Cr. */
export function formatINRCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1_00_00_000) return `${RUPEE}${(n / 1_00_00_000).toFixed(2)}Cr`;
  if (n >= 1_00_000) return `${RUPEE}${(n / 1_00_000).toFixed(2)}L`;
  return formatINR(n);
}

export type Urgency = "normal" | "soon" | "critical" | "ended";

export function urgencyFor(msRemaining: number): Urgency {
  if (msRemaining <= 0) return "ended";
  if (msRemaining <= 5 * 60_000) return "critical";
  if (msRemaining <= 60 * 60_000) return "soon";
  return "normal";
}

function splitRemaining(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return {
    d: Math.floor(total / 86400),
    h: Math.floor((total % 86400) / 3600),
    m: Math.floor((total % 3600) / 60),
    s: total % 60,
  };
}

/**
 * The live countdown ring.
 *
 * The visible sweep is driven by a CSS custom property registered as an
 * <angle> via @property, so the browser interpolates it on the compositor. The
 * component sets it once a second; the CSS transition covers the gap. Nothing
 * here repaints a gradient per frame.
 *
 * `windowMs` is what a full ring MEANS. It is the lot's own duration where that
 * is known, so a 2-hour auction and a 48-hour auction both start full and both
 * drain at a rate the viewer can read — a fixed window would make every short
 * lot look nearly over from the moment it opened.
 */
export function CountdownRing({
  endsAt,
  windowMs,
  onEnded,
}: {
  endsAt: string;
  windowMs?: number;
  onEnded?: () => void;
}) {
  const target = useMemo(() => new Date(endsAt).getTime(), [endsAt]);
  const [now, setNow] = useState(() => Date.now());
  const firedRef = useRef(false);

  useEffect(() => {
    // Reset when the deadline moves — anti-snipe extends it mid-auction, and a
    // ring that kept counting to the old target would show a lot as ended
    // while it is still taking bids.
    firedRef.current = false;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [endsAt]);

  const remaining = target - now;
  const urgency = urgencyFor(remaining);

  useEffect(() => {
    if (remaining <= 0 && !firedRef.current) {
      firedRef.current = true;
      onEnded?.();
    }
  }, [remaining, onEnded]);

  const span = windowMs && windowMs > 0 ? windowMs : 2 * 60 * 60 * 1000;
  const fraction = Math.max(0, Math.min(1, remaining / span));
  const { d, h, m, s } = splitRemaining(remaining);

  const label =
    remaining <= 0
      ? "ended"
      : d > 0
        ? `${d}d ${h}h`
        : h > 0
          ? `${h}:${String(m).padStart(2, "0")}`
          : `${m}:${String(s).padStart(2, "0")}`;

  return (
    <div
      className="auc-ring"
      data-urgency={urgency}
      style={{ ["--auc-sweep" as string]: `${fraction * 360}deg` }}
      role="timer"
      aria-live={urgency === "critical" ? "polite" : "off"}
      aria-label={
        remaining <= 0
          ? "Auction ended"
          : `Time remaining: ${d ? `${d} days ` : ""}${h} hours ${m} minutes`
      }
    >
      <span>{label}</span>
    </div>
  );
}

export function ConditionChip({ condition }: { condition: string }) {
  const label =
    condition === "partial_working"
      ? "partial"
      : condition === "refurbished"
        ? "refurb"
        : condition;
  return (
    <span className="auc-chip" data-condition={condition}>
      {label}
    </span>
  );
}

export function StatusChip({ status }: { status: string }) {
  const tone =
    status === "live"
      ? "live"
      : status === "cancelled" || status === "paused"
        ? "warn"
        : "muted";
  return (
    <span className="auc-chip" data-tone={tone}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

/**
 * The SOH gauge. Bands match `SOH_SCRAP_BELOW` / `SOH_REFURBISHABLE_MIN` in
 * src/lib/nbfc/recovery/stages.ts so the bar and the grade chip beside it
 * cannot tell different stories.
 */
export function SohBar({ soh }: { soh: number | null }) {
  if (soh === null || !Number.isFinite(soh)) {
    return <span className="auc-lotcode">SOH n/a</span>;
  }
  const band = soh >= 70 ? "good" : soh >= 55 ? "partial" : "scrap";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem" }}>
      <span
        className="auc-soh"
        data-band={band}
        style={{ ["--soh" as string]: String(Math.max(0, Math.min(100, soh))) }}
        role="img"
        aria-label={`State of health ${soh} percent`}
      />
      <span className="auc-lotcode">{soh}%</span>
    </span>
  );
}

export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="auc-eyebrow">{children}</div>;
}
