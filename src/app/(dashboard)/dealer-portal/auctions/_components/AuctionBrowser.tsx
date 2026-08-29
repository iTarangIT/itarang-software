"use client";

/**
 * E-234 — the dealer auction grid (BRD §10, §21).
 *
 * Filters are SERVER-side over the audience-scoped list, not client-side over a
 * fetched page: the dealer may be eligible for hundreds of lots, and filtering
 * after the fact would page through lots the filter has already excluded.
 *
 * Polls every 5s. There is no realtime substrate in this app — no WebSocket, no
 * SSE, no supabase-realtime — and the design document explicitly says to poll
 * first. The shared `["auction", ...]` query-key prefix means a bid placed on
 * the detail page refreshes this grid too.
 *
 * WHAT CHANGED
 *   · §21 asked for nine filters and six were on screen. State, city and
 *     minimum price were accepted by the API all along and never exposed. They
 *     are selects, not text boxes, because the server compares them with a
 *     case-sensitive `=` against the frozen audience row — a typed "kanpur"
 *     silently matches nothing. `/facets` supplies the exact values.
 *   · The filter row was a horizontal scroll strip on a phone, with an
 *     auto-margined sort select inside the overflow container that drifted off
 *     the end and could not be reached. Below 60rem the filters now live in a
 *     bottom sheet behind one button.
 *   · Filters are mirrored into the query string, so a search can be
 *     bookmarked, shared, or survive a reload.
 *   · "No results" now distinguishes "nothing matches your filters" from
 *     "nothing is visible to your account" — the second is an audience problem
 *     and the two used to render identically.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AuctionLotCard,
  type LotCardData,
} from "@/components/auction/AuctionLotCard";
import { Eyebrow } from "@/components/auction/AuctionPrimitives";
import { dealerFetch } from "@/lib/auction/client";

type StatusTab = "live" | "ending_soon" | "ended" | "all";
type SortKey = "ending_soon" | "newest" | "price_asc" | "price_desc" | "nearest";

const TABS: Array<{ key: StatusTab; label: string }> = [
  { key: "live", label: "Live now" },
  { key: "ending_soon", label: "Ending within the hour" },
  { key: "ended", label: "Closed" },
  { key: "all", label: "All" },
];

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "ending_soon", label: "Ending soonest" },
  { key: "newest", label: "Newest" },
  { key: "price_asc", label: "Price: low to high" },
  { key: "price_desc", label: "Price: high to low" },
  { key: "nearest", label: "Nearest to me" },
];

const CONDITIONS = [
  { key: "", label: "Any condition" },
  { key: "new", label: "New" },
  { key: "refurbished", label: "Refurbished" },
  { key: "partial_working", label: "Partial working" },
];

const TYPES = [
  { key: "", label: "Any type" },
  { key: "cash", label: "Cash" },
  { key: "cash_refinance", label: "Cash + refinance" },
];

const DISTANCES = [
  { key: "", label: "Any distance" },
  { key: "25", label: "Within 25 km" },
  { key: "50", label: "Within 50 km" },
  { key: "150", label: "Within 150 km" },
  { key: "500", label: "Within 500 km" },
];

interface Filters {
  status: StatusTab;
  sort: SortKey;
  condition: string;
  auction_type: string;
  state: string;
  city: string;
  max_distance_km: string;
  min_price: string;
  max_price: string;
}

const EMPTY: Filters = {
  status: "live",
  sort: "ending_soon",
  condition: "",
  auction_type: "",
  state: "",
  city: "",
  max_distance_km: "",
  min_price: "",
  max_price: "",
};

/** Which filters count as "narrowing" — drives the count on the sheet button. */
const NARROWING: Array<keyof Filters> = [
  "condition",
  "auction_type",
  "state",
  "city",
  "max_distance_km",
  "min_price",
  "max_price",
];

export function AuctionBrowser() {
  const router = useRouter();
  const search = useSearchParams();

  const [filters, setFilters] = useState<Filters>(() => {
    const f = { ...EMPTY };
    for (const k of Object.keys(EMPTY) as Array<keyof Filters>) {
      const v = search?.get(k);
      if (v) (f as Record<string, string>)[k] = v;
    }
    return f;
  });
  const [sheetOpen, setSheetOpen] = useState(false);

  const params = new URLSearchParams();
  params.set("status", filters.status);
  params.set("sort", filters.sort);
  for (const k of NARROWING) {
    if (filters[k]) params.set(k, filters[k]);
  }
  const qs = params.toString();

  // Mirror into the URL without pushing history on every keystroke.
  useEffect(() => {
    router.replace(`?${qs}`, { scroll: false });
  }, [qs, router]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["auction", "dealer", "list", qs],
    queryFn: () =>
      dealerFetch<{ items: LotCardData[]; total: number }>(
        `/api/dealer/auctions?${qs}`,
      ),
    // Live prices go stale fast, but not so fast that a grid needs the 2s the
    // open detail page uses.
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    staleTime: 2_000,
  });

  // The option lists for state/city. Cheap, rarely changes, and only ever the
  // values this dealer's own audience rows actually contain.
  const facets = useQuery({
    queryKey: ["auction", "dealer", "facets"],
    queryFn: () =>
      dealerFetch<{ states: string[]; cities: string[] }>(
        "/api/dealer/auctions/facets",
      ),
    staleTime: 5 * 60_000,
  });

  const items = data?.items ?? [];
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  const activeCount = NARROWING.filter((k) => filters[k]).length;
  const filtered = activeCount > 0;

  const controls = (
    <>
      <div className="auc-field">
        <label htmlFor="f-condition">Condition</label>
        <select
          id="f-condition"
          className="auc-text"
          value={filters.condition}
          onChange={(e) => set("condition", e.target.value)}
        >
          {CONDITIONS.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div className="auc-field">
        <label htmlFor="f-type">Type</label>
        <select
          id="f-type"
          className="auc-text"
          value={filters.auction_type}
          onChange={(e) => set("auction_type", e.target.value)}
        >
          {TYPES.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <div className="auc-field">
        <label htmlFor="f-state">State</label>
        <select
          id="f-state"
          className="auc-text"
          value={filters.state}
          onChange={(e) => set("state", e.target.value)}
        >
          <option value="">Any state</option>
          {(facets.data?.states ?? []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      <div className="auc-field">
        <label htmlFor="f-city">City</label>
        <select
          id="f-city"
          className="auc-text"
          value={filters.city}
          onChange={(e) => set("city", e.target.value)}
        >
          <option value="">Any city</option>
          {(facets.data?.cities ?? []).map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div className="auc-field">
        <label htmlFor="f-distance">Distance</label>
        <select
          id="f-distance"
          className="auc-text"
          value={filters.max_distance_km}
          onChange={(e) => set("max_distance_km", e.target.value)}
        >
          {DISTANCES.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
      </div>

      <div className="auc-field">
        <label htmlFor="f-min">Min price</label>
        <input
          id="f-min"
          className="auc-text"
          data-numeric="true"
          data-invalid={
            filters.min_price !== "" &&
            filters.max_price !== "" &&
            Number(filters.min_price) > Number(filters.max_price)
          }
          inputMode="numeric"
          placeholder="₹ any"
          value={filters.min_price}
          onChange={(e) => set("min_price", e.target.value.replace(/\D/g, ""))}
        />
      </div>

      <div className="auc-field">
        <label htmlFor="f-max">Max price</label>
        <input
          id="f-max"
          className="auc-text"
          data-numeric="true"
          inputMode="numeric"
          placeholder="₹ any"
          value={filters.max_price}
          onChange={(e) => set("max_price", e.target.value.replace(/\D/g, ""))}
        />
      </div>

      <div className="auc-field auc-toolbar-end">
        <label htmlFor="f-sort">Sort</label>
        <select
          id="f-sort"
          className="auc-text"
          value={filters.sort}
          onChange={(e) => set("sort", e.target.value as SortKey)}
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
    </>
  );

  return (
    <div className="auction-sheet">
      <header style={{ marginBlockEnd: "1.5rem" }}>
        <h1 className="auc-h1">Battery auctions</h1>
        <p className="auc-lede">
          Recovered batteries offered by our NBFC partners. You see the highest
          standing bid on every lot — never who placed it. Bids are binding.
        </p>
      </header>

      <div className="auc-tabs" role="tablist" aria-label="Auction status">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            className="auc-tab"
            aria-selected={filters.status === t.key}
            onClick={() => set("status", t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="auc-toolbar" data-collapsible="true">
        {controls}
        <button
          type="button"
          className="auc-btn auc-filter-trigger"
          data-variant="ghost"
          onClick={() => setSheetOpen(true)}
        >
          Filters{activeCount > 0 ? ` · ${activeCount}` : ""}
        </button>
      </div>

      {sheetOpen ? (
        <>
          <div
            className="auc-sheet-scrim"
            onClick={() => setSheetOpen(false)}
            aria-hidden="true"
          />
          <div
            className="auc-bottom-sheet"
            role="dialog"
            aria-modal="true"
            aria-label="Filters"
          >
            <header>
              <span className="auc-label">Filters</span>
              <button
                type="button"
                className="auc-btn"
                data-variant="ghost"
                onClick={() => setSheetOpen(false)}
              >
                Done
              </button>
            </header>
            {controls}
            <button
              type="button"
              className="auc-btn"
              data-variant="ghost"
              onClick={() => setFilters({ ...EMPTY, status: filters.status })}
            >
              Clear all
            </button>
          </div>
        </>
      ) : null}

      {isLoading ? (
        <div className="auc-grid">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="auc-skel-card">
              <div className="auc-skel" style={{ height: "1rem", width: "45%" }} />
              <div className="auc-skel" style={{ height: "2.25rem", width: "75%" }} />
              <div className="auc-skel" style={{ height: "1rem" }} />
              <div className="auc-skel" style={{ height: "1rem", width: "55%" }} />
              <div
                className="auc-skel"
                style={{ height: "2.5rem", marginBlockStart: "auto" }}
              />
            </div>
          ))}
        </div>
      ) : isError ? (
        <div className="auc-inline-error">
          {(error as Error).message}
        </div>
      ) : items.length === 0 ? (
        <div className="auc-empty">
          <p>
            {filtered
              ? "No lots match these filters"
              : filters.status === "live"
                ? "No auctions running right now"
                : "Nothing here yet"}
          </p>
          <p className="auc-empty-hint">
            {filtered
              ? "Widen or clear the filters to see everything available to you."
              : "You will be notified — in the app, by email and on WhatsApp — the moment a lot you can bid on is published. Lots are shown only to dealers inside the seller's chosen area."}
          </p>
          {filtered ? (
            <button
              type="button"
              className="auc-btn"
              onClick={() => setFilters({ ...EMPTY, status: filters.status })}
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <Eyebrow>
            {items.length} lot{items.length === 1 ? "" : "s"}
            {filtered ? " matching" : ""}
          </Eyebrow>
          <div className="auc-grid" style={{ marginBlockStart: "0.75rem" }}>
            {items.map((lot) => (
              <AuctionLotCard key={lot.lot_id} lot={lot} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export default AuctionBrowser;
