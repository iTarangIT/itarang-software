"use client";

/**
 * E-238 — the dealer <-> NBFC negotiation history for one financing offer.
 *
 * Rendered by all three portals (dealer product-selection, NBFC Acquire, admin
 * KYC review) from the same rows, so nobody can be shown a different version of
 * what was agreed. `viewer` only changes the labels — "You" instead of the
 * party name — never which rounds are visible.
 *
 * Each round is a FULL snapshot of the terms (see the schema comment on
 * nbfc_offer_negotiations). Showing all six numbers on every card would bury
 * the one that moved, so a round renders only the fields that CHANGED against
 * the previous round, with the previous value struck through beside the new
 * one. Round 1 has nothing to diff against and shows the full opening terms.
 *
 * Styling is plain Tailwind, matching NbfcRequestThread — the NBFC portal does
 * not import from @/components/ui, and this component has to live in both.
 */
import { useState } from "react";

import { FIELD_LABEL, NEGOTIABLE_FIELDS, changedFields } from "@/lib/nbfc/offer-negotiation";
import type { NegotiableField } from "@/lib/nbfc/offer-negotiation";
import { inr } from "@/lib/nbfc/format";

export interface NegotiationRound {
  id: string;
  round: number;
  party: string;
  kind: string;
  loan_amount: string | null;
  roi_pct: string | null;
  emi_amount: string | null;
  tenure_months: number | null;
  down_payment: string | null;
  processing_fee: string | null;
  conditions: string | null;
  message: string | null;
  created_at: string;
}

type Viewer = "dealer" | "nbfc" | "admin";

const PARTY_STYLE: Record<string, string> = {
  nbfc: "bg-sky-50 text-sky-700 border-sky-200",
  dealer: "bg-violet-50 text-violet-700 border-violet-200",
};

const KIND_LABEL: Record<string, string> = {
  offer: "Offer",
  counter: "Counter-offer",
  fix: "Terms fixed",
};

/** "You" wherever the viewer is the party — an NBFC officer reading "NBFC asked" is odd. */
function partyLabel(party: string, viewer: Viewer): string {
  if (viewer === "nbfc" && party === "nbfc") return "You";
  if (viewer === "dealer" && party === "dealer") return "You";
  return party === "nbfc" ? "NBFC" : "Dealer";
}

/** Money fields get ₹ and grouping; ROI a %; tenure a "mo". */
function formatTerm(field: NegotiableField, value: string | number | null): string {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (Number.isNaN(n)) return String(value);
  if (field === "roi_pct") return `${value}%`;
  if (field === "tenure_months") return `${n} mo`;
  return `₹${inr(n)}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

export default function OfferNegotiationThread({
  rounds,
  viewer,
  collapsible = true,
}: {
  rounds: NegotiationRound[];
  viewer: Viewer;
  /** Dealer/NBFC panels tuck it behind a toggle; the admin view shows it open. */
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(!collapsible);

  // A lone opening round is not a negotiation — the terms are already on the
  // card above this component, so rendering "Round 1: the offer" is noise.
  if (rounds.length < 2) return null;

  const ordered = [...rounds].sort((a, b) => a.round - b.round);
  const newestFirst = [...ordered].reverse();

  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-[11px] font-semibold text-[color:var(--color-brand-sky)] hover:underline"
        >
          {open ? "Hide" : "Show"} negotiation history ({ordered.length} rounds)
        </button>
      ) : (
        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
          Negotiation history
        </p>
      )}

      {open && (
        <ul className="mt-2 space-y-2">
          {newestFirst.map((r) => {
            const prev = ordered.find((x) => x.round === r.round - 1) ?? null;
            const changed = changedFields(prev, r);
            // Round 1 has no predecessor to diff against; a `fix` round restates
            // terms that by definition did not move, so both show the full set.
            const fields: NegotiableField[] =
              prev == null || r.kind === "fix" ? [...NEGOTIABLE_FIELDS] : changed;

            return (
              <li key={r.id} className="rounded-lg border border-slate-200 bg-white p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                        PARTY_STYLE[r.party] ?? "bg-slate-100 text-slate-600 border-slate-200"
                      }`}
                    >
                      {partyLabel(r.party, viewer)}
                    </span>
                    <span className="text-xs font-semibold text-slate-700">
                      {KIND_LABEL[r.kind] ?? r.kind}
                    </span>
                    {r.kind === "fix" && (
                      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">
                        Fixed
                      </span>
                    )}
                  </div>
                  <span className="shrink-0 text-[10px] text-slate-400">
                    Round {r.round} · {formatWhen(r.created_at)}
                  </span>
                </div>

                {fields.length > 0 && (
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
                    {fields.map((f) => {
                      const moved = prev != null && changed.includes(f);
                      return (
                        <div key={f}>
                          <dt className="text-[9px] font-bold uppercase tracking-wider text-slate-400">
                            {FIELD_LABEL[f]}
                          </dt>
                          <dd className="text-xs text-slate-700">
                            {moved && (
                              <span className="mr-1 text-slate-400 line-through">
                                {formatTerm(f, prev![f])}
                              </span>
                            )}
                            <span className={moved ? "font-semibold text-slate-900" : ""}>
                              {formatTerm(f, r[f])}
                            </span>
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                )}

                {/* A counter that only carried a message moves nothing — say so
                    rather than rendering an empty card. */}
                {fields.length === 0 && !r.message && (
                  <p className="mt-1.5 text-xs text-slate-400">No change to the terms.</p>
                )}

                {r.message && (
                  <p className="mt-2 whitespace-pre-line rounded-md bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600">
                    {r.message}
                  </p>
                )}
                {r.kind !== "counter" && r.conditions && (
                  <p className="mt-1.5 whitespace-pre-line text-[11px] text-slate-500">
                    <span className="font-semibold">Conditions:</span> {r.conditions}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
