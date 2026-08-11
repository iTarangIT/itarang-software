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
 * the detail page refreshes this grid too, the discipline
 * useBuybackNotifications.ts already establishes.
 */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AuctionLotCard, type LotCardData } from "@/components/auction/AuctionLotCard";
import { Eyebrow } from "@/components/auction/AuctionPrimitives";

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

interface Filters {
  status: StatusTab;
  sort: SortKey;
  condition: string;
  auction_type: string;
  max_distance_km: string;
  max_price: string;
}

const EMPTY: Filters = {
  status: "live",
  sort: "ending_soon",
  condition: "",
  auction_type: "",
  max_distance_km: "",
  max_price: "",
};

export function AuctionBrowser() {
  const [filters, setFilters] = useState<Filters>(EMPTY);

  const params = new URLSearchParams();
  params.set("status", filters.status);
  params.set("sort", filters.sort);
  if (filters.condition) params.set("condition", filters.condition);
  if (filters.auction_type) params.set("auction_type", filters.auction_type);
  if (filters.max_distance_km) params.set("max_distance_km", filters.max_distance_km);
  if (filters.max_price) params.set("max_price", filters.max_price);
  const qs = params.toString();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["auction", "dealer", "list", qs],
    queryFn: async () => {
      const res = await fetch(`/api/dealer/auctions?${qs}`);
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Could not load auctions.");
      }
      return json.data as { items: LotCardData[]; total: number };
    },
    // Live prices go stale fast, but not so fast that a grid needs the 2s the
    // open detail page uses.
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    staleTime: 2_000,
  });

  const items = data?.items ?? [];
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));

  return (
    <div className="auction-sheet">
      <header style={{ marginBottom: "1.5rem" }}>
        <h1 className="auc-h1">Battery auctions</h1>
        <p className="auc-lede">
          Recovered batteries offered by our NBFC partners. You see the highest
          standing bid on every lot — never who placed it. Bids are binding.
        </p>
      </header>

      {/* Status tabs */}
      <div
        role="tablist"
        aria-label="Auction status"
        style={{ display: "flex", flexWrap: "wrap", gap: "0.375rem", marginBottom: "0.75rem" }}
      >
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={filters.status === t.key}
            onClick={() => set("status", t.key)}
            className="auc-btn"
            data-variant={filters.status === t.key ? undefined : "ghost"}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filter row */}
      <div
        className="auc-scroll-x"
        style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginBottom: "1.25rem", paddingBottom: "0.25rem" }}
      >
        <select
          className="auc-input"
          style={{ flex: "0 0 auto", inlineSize: "auto" }}
          value={filters.condition}
          onChange={(e) => set("condition", e.target.value)}
          aria-label="Filter by condition"
        >
          {CONDITIONS.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>

        <select
          className="auc-input"
          style={{ flex: "0 0 auto", inlineSize: "auto" }}
          value={filters.auction_type}
          onChange={(e) => set("auction_type", e.target.value)}
          aria-label="Filter by payment type"
        >
          <option value="">Cash or refinance</option>
          <option value="cash">Cash only</option>
          <option value="cash_refinance">Cash + refinance</option>
        </select>

        <select
          className="auc-input"
          style={{ flex: "0 0 auto", inlineSize: "auto" }}
          value={filters.max_distance_km}
          onChange={(e) => set("max_distance_km", e.target.value)}
          aria-label="Filter by distance"
        >
          <option value="">Any distance</option>
          <option value="25">Within 25 km</option>
          <option value="50">Within 50 km</option>
          <option value="150">Within 150 km</option>
          <option value="500">Within 500 km</option>
        </select>

        <input
          className="auc-input"
          style={{ flex: "0 0 auto", inlineSize: "11rem" }}
          type="number"
          min={0}
          placeholder="Max price ₹"
          value={filters.max_price}
          onChange={(e) => set("max_price", e.target.value)}
          aria-label="Maximum price"
        />

        <select
          className="auc-input"
          style={{ flex: "0 0 auto", inlineSize: "auto", marginInlineStart: "auto" }}
          value={filters.sort}
          onChange={(e) => set("sort", e.target.value as SortKey)}
          aria-label="Sort order"
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <Eyebrow>
        {isLoading ? "loading" : `${items.length} lot${items.length === 1 ? "" : "s"} visible to you`}
      </Eyebrow>

      {isError && (
        <div
          className="auc-chip"
          data-tone="warn"
          style={{ display: "block", padding: "0.75rem" }}
        >
          {error instanceof Error ? error.message : "Could not load auctions."}
        </div>
      )}

      {!isLoading && !isError && items.length === 0 && (
        <div
          style={{
            border: "1px dashed var(--auc-rule-strong)",
            padding: "2.5rem 1.5rem",
            textAlign: "center",
            color: "var(--auc-ink-2)",
          }}
        >
          <p style={{ fontFamily: "var(--auc-display)", fontSize: "1.125rem", color: "var(--auc-ink)" }}>
            No lots match this filter
          </p>
          <p style={{ fontSize: "0.875rem", marginTop: "0.375rem" }}>
            {filters.status === "live"
              ? "Nothing is live for your area right now. You are notified the moment a lot opens to you."
              : "Try widening the filters, or check the Live tab."}
          </p>
        </div>
      )}

      <div className="auc-grid">
        {items.map((lot) => (
          <AuctionLotCard key={lot.lot_id} lot={lot} />
        ))}
      </div>
    </div>
  );
}
