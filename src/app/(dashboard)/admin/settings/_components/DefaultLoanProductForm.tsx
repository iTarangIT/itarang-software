"use client";

// E-282/E-283/E-286/E-289 — Settings → Loan Product. One table of pinned
// defaults plus an add row. A rule names a dealer, a DEALER location, a
// CUSTOMER location, or any combination; every field it leaves blank means
// "any".
//
// TWO LOCATION PAIRS, AND THEY SOURCE THEIR OPTIONS FROM OPPOSITE PLACES —
// which is the one thing to keep straight when editing this file:
//
//   Dealer state / Dealer cities   → accounts.state / accounts.city, so the
//     lists are built from the dealers this screen already loaded, NOT from
//     country-state-city. A dealer's address is captured at onboarding and may
//     not be spelled the way that package spells it, so offering every city in
//     India here would mostly offer cities no rule could ever match.
//
//   Customer state / Customer cities → leads.state / leads.city, so the lists
//     ARE country-state-city. That is exactly what the Step 1 lead form writes
//     and what nbfc_loan_products.active_locations declares, and the BRE
//     compares those with ===, so anything else would produce a rule that can
//     never match.
//
// The dealer picker rides /api/admin/dealers, whose `id` IS the dealer code
// stored on the rule.
//
// Several cities can be pinned at once on either leg. A rule row still carries
// ONE dealer city and ONE customer city — that is what the resolver and the
// partial unique index key on — so the POST fans the selection out into one
// rule per PAIR. Each stays independently listed and removable, and the table
// still reads top-down as the resolution order.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Info, Loader2, Plus, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CityMultiCombobox } from "@/components/admin/nbfc/StateCityPicker";
import { useIndiaLocationData } from "@/lib/location/useIndiaLocationData";

/** Matches the cap the POST route enforces on (dealer cities × customer cities). */
const MAX_ROWS_PER_SAVE = 200;

type Row = {
  id: number;
  dealerCode: string | null;
  dealerName: string | null;
  state: string | null;
  city: string | null;
  customerState: string | null;
  customerCity: string | null;
  priority: number;
  nbfcId: number;
  loanProductId: number;
  notes: string | null;
  updatedAt: string | null;
  nbfcShortName: string | null;
  nbfcCode: string | null;
  productName: string | null;
  productStatus: string | null;
};

type Product = {
  id: number;
  productName: string;
  loanAmountMin: number;
  loanAmountMax: number;
  /** The lender's own coverage. Empty = everywhere. */
  activeLocations: { state: string; city: string }[];
};

type Nbfc = {
  id: number;
  shortName: string;
  legalName: string;
  code: string;
  products: Product[];
};

type Payload = { rows: Row[]; nbfcs: Nbfc[] };

type DealerOption = {
  id: string;
  business_entity_name: string;
  dealer_code: string | null;
  city: string | null;
  state: string | null;
};

const norm = (s: string) => s.trim().toLowerCase();

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/**
 * Does the lender's own coverage reach this place?
 *
 * Mirrors the BRE's active_locations rule (src/lib/bre/match.ts) exactly,
 * including its wildcards: an empty list serves everywhere, and a blank state
 * or city on an entry — or a rule that names no customer city — is a wildcard.
 * The comparison is === there, so it is === here: a case difference really
 * would stop the product matching, and the warning should say so.
 */
function coversLocation(
  product: Product,
  state: string,
  city: string | null,
): boolean {
  const locs = product.activeLocations ?? [];
  if (locs.length === 0) return true;
  return locs.some((loc) => {
    const stateOk = !loc.state || loc.state === state;
    const cityOk = !loc.city || !city || loc.city === city;
    return stateOk && cityOk;
  });
}

/**
 * The "what is Priority even for" panel behind the ⓘ next to that field.
 *
 * It exists because the field reads as though it always has to be set, when in
 * practice the honest answer is "leave it at 0" — the resolver's own
 * more-fields-wins order already does the right thing for rules that differ in
 * how specific they are. Priority is the OVERRIDE, and an override only makes
 * sense once you have seen the thing it overrides, so the panel leads with the
 * case where none is needed and then shows the two where one is.
 *
 * Written inline rather than as a shared component: the repo has no tooltip or
 * popover primitive, and one screen's worth of copy does not justify inventing
 * the abstraction here.
 */
function PriorityHelp() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span ref={rootRef} className="relative inline-flex align-middle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="What does priority do?"
        title="What does priority do?"
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-ink-muted transition hover:text-ink"
      >
        <Info className="h-3.5 w-3.5" />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="What does priority do?"
          className="absolute right-0 top-6 z-30 w-[22rem] max-w-[80vw] space-y-3 rounded-xl border border-border bg-surface p-4 text-xs leading-relaxed text-ink-muted shadow-lg"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-semibold text-ink">
              Priority is an override
            </p>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="-mr-1 -mt-1 rounded p-1 text-ink-muted transition hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <p>
            Leave it at <strong className="text-ink">0</strong> unless you want
            to beat the normal order. Raise it only when you catch yourself
            thinking &ldquo;ignore the usual rules, use this one for now&rdquo;.
          </p>

          <div className="space-y-1">
            <p className="font-semibold text-ink">
              You don&apos;t need it here
            </p>
            <p>
              &ldquo;Customers in Maharashtra → Bajaj&rdquo; (0) and
              &ldquo;Customers in Nashik → iTarang F1&rdquo; (0). Nashik names
              more, so it is checked first: a Nashik customer gets iTarang F1, a
              Pune customer gets Bajaj. Nothing to set.
            </p>
          </div>

          <div className="space-y-1">
            <p className="font-semibold text-ink">
              You do need it: a temporary push
            </p>
            <p>
              For three weeks every Maharashtra customer should go to Delovita —
              Nashik included. Add &ldquo;Customers in Maharashtra →
              Delovita&rdquo; at <strong className="text-ink">100</strong>. It
              now outranks the Nashik rule. Remove it later and Nashik goes back
              to iTarang F1 on its own — you never had to delete the other
              rules.
            </p>
          </div>

          <div className="space-y-1">
            <p className="font-semibold text-ink">
              You do need it: two equally specific rules
            </p>
            <p>
              &ldquo;Dealer = Ayansh Engineering → Bajaj&rdquo; and
              &ldquo;Customers in Nashik → iTarang F1&rdquo; both name one
              field, and both match an Ayansh customer living in Nashik. The
              dealer rule wins by default. Want the city to win instead? Give it{" "}
              <strong className="text-ink">10</strong>.
            </p>
          </div>

          <p className="border-t border-border pt-2">
            It cannot force a product onto someone it does not suit. Serviceable
            locations, the loan amount ceiling, battery category and blocked
            lenders are all checked first — a rule at 1000 pinned to a product
            that does not fit is simply skipped, and the next one is tried.
          </p>
        </div>
      )}
    </span>
  );
}

/** How a rule reads in one line, for toasts and confirm dialogs. */
function describeScope(
  dealerLabel: string | null,
  state: string | null,
  cities: string[],
  customerState: string | null,
  customerCities: string[],
): string {
  const place = (
    label: string,
    st: string | null,
    list: string[],
  ): string | null => {
    if (!st) return null;
    if (list.length === 0) return `${label} in ${st}`;
    if (list.length === 1) return `${label} in ${list[0]}, ${st}`;
    return `${label} in ${list.length} cities of ${st}`;
  };

  const parts = [
    dealerLabel,
    place("dealers", state, cities),
    place("customers", customerState, customerCities),
  ].filter(Boolean) as string[];

  if (parts.length === 0) return "everywhere";
  if (parts.length === 1 && dealerLabel) return `${dealerLabel} (wherever it is)`;
  return parts.join(" — ");
}

export function DefaultLoanProductForm() {
  const qc = useQueryClient();

  // Lazy-loaded ~MB-scale dataset; the CUSTOMER dropdowns render disabled until
  // it lands. The DEALER dropdowns do not use it — see the header.
  const indiaLocations = useIndiaLocationData();

  const [dealerCode, setDealerCode] = useState("");
  const [state, setState] = useState("");
  const [cities, setCities] = useState<string[]>([]);
  const [stateWide, setStateWide] = useState(false);
  const [customerState, setCustomerState] = useState("");
  const [customerCities, setCustomerCities] = useState<string[]>([]);
  const [customerStateWide, setCustomerStateWide] = useState(false);
  const [nbfcId, setNbfcId] = useState("");
  const [productId, setProductId] = useState("");
  const [priority, setPriority] = useState("0");
  const [saving, setSaving] = useState(false);

  const { data, isLoading, error } = useQuery<Payload>({
    queryKey: ["default-loan-products"],
    queryFn: async () => {
      const res = await fetch("/api/admin/settings/loan-products", {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(
          json?.error?.message ?? "Failed to load loan product defaults",
        );
      }
      return json.data as Payload;
    },
  });

  const dealersQuery = useQuery<{ success: true; data: DealerOption[] }>({
    queryKey: ["admin-dealers-for-loan-product-defaults"],
    queryFn: async () => {
      const res = await fetch("/api/admin/dealers?limit=500", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Failed to load dealers");
      return res.json();
    },
    staleTime: 5 * 60_000,
  });
  const dealers = useMemo(
    () => dealersQuery.data?.data ?? [],
    [dealersQuery.data],
  );

  // The lenders `loadActiveProductsForDealer` drops for the chosen dealer. A
  // pin on one of these could never fire, so the form warns before saving.
  const blockedQuery = useQuery<number[]>({
    queryKey: ["loan-product-blocked-nbfcs", dealerCode],
    queryFn: async () => {
      const res = await fetch(
        `/api/admin/settings/loan-products?dealerCode=${encodeURIComponent(dealerCode)}`,
        { cache: "no-store" },
      );
      const json = await res.json();
      if (!res.ok || !json.success) return [];
      return (json.data?.blockedNbfcIds ?? []) as number[];
    },
    enabled: !!dealerCode,
    staleTime: 5 * 60_000,
  });

  // Every state iTarang has a dealer in, and the cities within the chosen one.
  // Anything outside these lists could only produce a rule that never matches.
  const dealerStates = useMemo(() => {
    const seen = new Map<string, string>();
    for (const d of dealers) {
      const v = d.state?.trim();
      if (v && !seen.has(norm(v))) seen.set(norm(v), v);
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }, [dealers]);

  const dealerCities = useMemo(() => {
    if (!state) return [];
    const seen = new Map<string, string>();
    for (const d of dealers) {
      if (norm(d.state ?? "") !== norm(state)) continue;
      const v = d.city?.trim();
      if (v && !seen.has(norm(v))) seen.set(norm(v), v);
    }
    return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
  }, [dealers, state]);

  // The customer's own state list — every Indian state, because leads.state is
  // written from this same package rather than from the dealer directory.
  const customerStateIso = useMemo(
    () =>
      indiaLocations.states.find((s) => s.name === customerState)?.isoCode ??
      undefined,
    [indiaLocations.states, customerState],
  );

  // "Any location" is only a valid rule when a dealer scopes it — the API
  // rejects a rule that names neither. Drop back to a located rule if the
  // dealer is cleared while no state is selected.
  const anyLocation = !!dealerCode && !state && !customerState;
  useEffect(() => {
    if (!dealerCode && !state) setStateWide(false);
  }, [dealerCode, state]);

  const selectedNbfc = data?.nbfcs.find((n) => String(n.id) === nbfcId) ?? null;
  const selectedProduct =
    selectedNbfc?.products.find((p) => String(p.id) === productId) ?? null;
  const selectedDealer = dealers.find((d) => d.id === dealerCode) ?? null;

  const effectiveState = state || null;
  const effectiveCustomerState = customerState || null;
  // Empty = the rule covers the whole state (or carries no location at all)
  // and is written as a single row on that leg. Otherwise one row per entry.
  const effectiveCities = useMemo(
    () => (!effectiveState || stateWide ? [] : cities),
    [effectiveState, stateWide, cities],
  );
  const effectiveCustomerCities = useMemo(
    () =>
      !effectiveCustomerState || customerStateWide ? [] : customerCities,
    [effectiveCustomerState, customerStateWide, customerCities],
  );

  // One row per (dealer city, customer city) pair — the two multi-selects
  // multiply, which is what the 200-row cap on both sides bounds.
  const rowCount =
    Math.max(effectiveCities.length, 1) *
    Math.max(effectiveCustomerCities.length, 1);

  // A rule that names BOTH a dealer and a dealer location only matches while
  // that dealer sits in it. Naming a location the dealer is not in produces a
  // rule that can never fire, so the form says so before it is saved.
  const dealerLocationConflict = useMemo(() => {
    if (!selectedDealer || !effectiveState) return false;
    if (norm(selectedDealer.state ?? "") !== norm(effectiveState)) return true;
    if (effectiveCities.length === 0) return false;
    return !effectiveCities.some(
      (c) => norm(c) === norm(selectedDealer.city ?? ""),
    );
  }, [selectedDealer, effectiveState, effectiveCities]);

  // E-289 — the BRE drops a product whose active_locations do not cover the
  // customer BEFORE the pin is consulted, so a customer-scoped rule pinned to
  // a product that does not serve that place can never fire. Only checkable
  // now that a rule finally names a customer location; under E-286's
  // dealer-only scoping this warning said nothing and was removed.
  const uncoveredCustomerPlaces = useMemo(() => {
    if (!selectedProduct || !effectiveCustomerState) return [];
    if (effectiveCustomerCities.length === 0) {
      return coversLocation(selectedProduct, effectiveCustomerState, null)
        ? []
        : [effectiveCustomerState];
    }
    return effectiveCustomerCities.filter(
      (c) => !coversLocation(selectedProduct, effectiveCustomerState, c),
    );
  }, [selectedProduct, effectiveCustomerState, effectiveCustomerCities]);

  const blockedWarning =
    !!selectedNbfc && (blockedQuery.data ?? []).includes(selectedNbfc.id);

  const canSave =
    !!nbfcId &&
    !!productId &&
    // A rule must name a dealer or a location of either kind (API enforces it).
    (!!dealerCode || !!effectiveState || !!effectiveCustomerState) &&
    // With a state chosen on either leg, pick at least one city or say the
    // whole state.
    (!effectiveState || stateWide || cities.length > 0) &&
    (!effectiveCustomerState ||
      customerStateWide ||
      customerCities.length > 0) &&
    rowCount <= MAX_ROWS_PER_SAVE &&
    !saving;

  function resetForm() {
    setDealerCode("");
    setState("");
    setCities([]);
    setStateWide(false);
    setCustomerState("");
    setCustomerCities([]);
    setCustomerStateWide(false);
    setNbfcId("");
    setProductId("");
    setPriority("0");
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings/loan-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dealer_code: dealerCode || null,
          state: effectiveState,
          // One rule per (dealer city, customer city) pair; an empty list keeps
          // the state-wide / any-location shape a single row on that leg.
          cities: effectiveCities,
          customer_state: effectiveCustomerState,
          customer_cities: effectiveCustomerCities,
          nbfc_id: Number(nbfcId),
          loan_product_id: Number(productId),
          priority: Number(priority) || 0,
        }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Failed to save the default");
      }
      const created = Number(json.data?.created ?? 1);
      toast.success(
        `${created > 1 ? `${created} defaults` : "Default"} set for ${describeScope(
          selectedDealer?.business_entity_name ?? null,
          effectiveState,
          effectiveCities,
          effectiveCustomerState,
          effectiveCustomerCities,
        )}`,
      );
      resetForm();
      qc.invalidateQueries({ queryKey: ["default-loan-products"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function remove(row: Row) {
    const where = describeScope(
      row.dealerName,
      row.state,
      row.city ? [row.city] : [],
      row.customerState,
      row.customerCity ? [row.customerCity] : [],
    );
    if (!confirm(`Remove the default loan product for ${where}?`)) return;
    try {
      const res = await fetch(`/api/admin/settings/loan-products?id=${row.id}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json?.error?.message ?? "Failed to remove the default");
      }
      toast.success(`Default removed for ${where}`);
      qc.invalidateQueries({ queryKey: ["default-loan-products"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-ink-muted">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading loan product defaults…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        {error instanceof Error ? error.message : "Failed to load"}
      </div>
    );
  }

  const rows = data?.rows ?? [];
  const nbfcs = data?.nbfcs ?? [];

  return (
    <div className="space-y-6">
      {/* ── Add a default ────────────────────────────────────────────── */}
      <section className="space-y-5">
        <h2 className="text-sm font-semibold text-ink">Add a default</h2>

        {/* ── Which dealer ─────────────────────────────────────────── */}
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Which dealer
          </h3>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="space-y-1">
              <span className="text-xs font-medium text-ink-muted">Dealer</span>
              <select
                value={dealerCode}
                onChange={(e) => setDealerCode(e.target.value)}
                disabled={dealersQuery.isLoading}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              >
                <option value="">
                  {dealersQuery.isLoading ? "Loading…" : "Any dealer"}
                </option>
                {dealers.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.business_entity_name}
                    {d.city ? ` — ${d.city}` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-medium text-ink-muted">
                Dealer state
              </span>
              <select
                value={state}
                onChange={(e) => {
                  setState(e.target.value);
                  setCities([]);
                  if (!e.target.value) setStateWide(false);
                }}
                disabled={dealersQuery.isLoading}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              >
                <option value="">
                  {dealersQuery.isLoading ? "Loading…" : "Any dealer location"}
                </option>
                {dealerStates.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <div className="space-y-1">
              <span className="text-xs font-medium text-ink-muted">
                Dealer cities
              </span>
              {stateWide ? (
                <p className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-ink-muted">
                  All cities in {state || "the state"}
                </p>
              ) : (
                <CityMultiCombobox
                  options={dealerCities}
                  value={cities}
                  onChange={setCities}
                />
              )}
              <span className="block text-xs text-ink-muted">
                {!state
                  ? "Any city — pick a state to narrow it."
                  : stateWide
                    ? "Untick below to pin only certain cities."
                    : dealerCities.length === 0
                      ? "No dealer is registered in this state."
                      : "Cities you have dealers in. Pick as many as you like — one rule is saved per city."}
              </span>
            </div>
          </div>

          {state && (
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={stateWide}
                onChange={(e) => {
                  setStateWide(e.target.checked);
                  if (e.target.checked) setCities([]);
                }}
                className="h-4 w-4 rounded border-border"
              />
              Apply to every dealer in the state (a city entry still overrides
              this)
            </label>
          )}
        </div>

        {/* ── Which customers ──────────────────────────────────────── */}
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Which customers
          </h3>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="space-y-1">
              <span className="text-xs font-medium text-ink-muted">
                Customer state
              </span>
              <select
                value={customerState}
                onChange={(e) => {
                  setCustomerState(e.target.value);
                  setCustomerCities([]);
                  if (!e.target.value) setCustomerStateWide(false);
                }}
                disabled={!indiaLocations.loaded}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              >
                <option value="">
                  {indiaLocations.loaded ? "Any customer" : "Loading…"}
                </option>
                {indiaLocations.states.map((s) => (
                  <option key={s.isoCode} value={s.name}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>

            <div className="space-y-1">
              <span className="text-xs font-medium text-ink-muted">
                Customer cities
              </span>
              {customerStateWide ? (
                <p className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-ink-muted">
                  All cities in {customerState || "the state"}
                </p>
              ) : (
                <CityMultiCombobox
                  locations={indiaLocations}
                  stateIso={customerStateIso}
                  value={customerCities}
                  onChange={setCustomerCities}
                />
              )}
              <span className="block text-xs text-ink-muted">
                {!customerState
                  ? "Any customer — pick a state to narrow it by where the customer lives."
                  : customerStateWide
                    ? "Untick below to pin only certain cities."
                    : "Where the customer lives, off their lead address. Pick as many as you like — one rule is saved per city."}
              </span>
            </div>

            {/* Not a <label> wrapper: the ⓘ button lives beside the caption,
                and a button inside a label steals the click into the input. */}
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="default-loan-product-priority"
                  className="text-xs font-medium text-ink-muted"
                >
                  Priority
                </label>
                <PriorityHelp />
              </div>
              <input
                id="default-loan-product-priority"
                type="number"
                min={0}
                max={1000}
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              />
              <span className="block text-xs text-ink-muted">
                Leave at 0 unless you want a rule to beat the normal order.
                Highest wins; on a tie the rule that pins down more fields is
                checked first — then dealer, customer city, customer state,
                dealer city, dealer state.
              </span>
            </div>
          </div>

          {customerState && (
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={customerStateWide}
                onChange={(e) => {
                  setCustomerStateWide(e.target.checked);
                  if (e.target.checked) setCustomerCities([]);
                }}
                className="h-4 w-4 rounded border-border"
              />
              Apply to every customer in the state (a city entry still overrides
              this)
            </label>
          )}

          {customerState && (
            <p className="text-xs text-ink-muted">
              A WhatsApp lead whose address has not been read from their
              documents yet matches no customer rule — it falls through to the
              next rule, or to the normal matched list.
            </p>
          )}
        </div>

        {/* ── What is offered ──────────────────────────────────────── */}
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            What is offered
          </h3>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <label className="space-y-1">
              <span className="text-xs font-medium text-ink-muted">NBFC</span>
              <select
                value={nbfcId}
                onChange={(e) => {
                  setNbfcId(e.target.value);
                  setProductId("");
                }}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
              >
                <option value="">Select NBFC…</option>
                {nbfcs.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.shortName} ({n.code})
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-medium text-ink-muted">
                Loan product
              </span>
              <select
                value={productId}
                onChange={(e) => setProductId(e.target.value)}
                disabled={!selectedNbfc}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm disabled:opacity-50"
              >
                <option value="">Select product…</option>
                {selectedNbfc?.products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.productName} — up to {inr(p.loanAmountMax)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {rowCount > 1 && (
          <p className="text-sm text-ink-muted">
            This saves <strong>{rowCount}</strong> rules — one per
            {effectiveCities.length > 1 && effectiveCustomerCities.length > 1
              ? " dealer city and customer city pair"
              : effectiveCustomerCities.length > 1
                ? " customer city"
                : " dealer city"}
            , all pinned to the same lender and product. Each can be removed on
            its own below.
          </p>
        )}

        {rowCount > MAX_ROWS_PER_SAVE && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {effectiveCities.length} dealer cities × {" "}
              {effectiveCustomerCities.length} customer cities is {rowCount}{" "}
              rules. Narrow one of the two lists — at most{" "}
              {MAX_ROWS_PER_SAVE} rules can be saved at once.
            </span>
          </div>
        )}

        {anyLocation && (
          <p className="text-sm text-ink-muted">
            This rule applies to every customer of{" "}
            <strong>{selectedDealer?.business_entity_name ?? "the dealer"}</strong>
            , wherever that dealer is and wherever the customer lives. Add a
            location to narrow it.
          </p>
        )}

        {!dealerCode && !state && !customerState && (
          <p className="text-sm text-ink-muted">
            Choose a dealer, a dealer location, or a customer location — a
            default has to be scoped to at least one of them.
          </p>
        )}

        {blockedWarning && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>{selectedNbfc?.shortName}</strong> is blocked for{" "}
              {selectedDealer?.business_entity_name ?? "this dealer"}, so this
              default will never be offered. Re-enable the lender for the dealer
              first — you can still save this mapping now.
            </span>
          </div>
        )}

        {dealerLocationConflict && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>{selectedDealer?.business_entity_name}</strong> is
              registered in{" "}
              <strong>
                {[selectedDealer?.city, selectedDealer?.state]
                  .filter(Boolean)
                  .join(", ") || "another location"}
              </strong>
              , not in the dealer location you picked, so this rule can never
              match. Drop the location to pin the dealer wherever it is, or pick
              the dealer&apos;s own location — you can still save this mapping
              now.
            </span>
          </div>
        )}

        {uncoveredCustomerPlaces.length > 0 && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>{selectedProduct?.productName}</strong> does not serve{" "}
              <strong>{uncoveredCustomerPlaces.join(", ")}</strong>, so it is
              dropped before this default is even considered and the rule can
              never fire there. Add those places to the product&apos;s
              serviceable locations, or pick a product that already covers them
              — you can still save this mapping now.
            </span>
          </div>
        )}

        <Button onClick={save} disabled={!canSave}>
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          {rowCount > 1 ? `Save ${rowCount} defaults` : "Save default"}
        </Button>
      </section>

      {/* ── Current defaults ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">
          Current defaults ({rows.length})
        </h2>
        {rows.length > 0 && (
          <p className="text-xs text-ink-muted">
            Listed in the order they are checked. The first rule that matches a
            lead <em>and</em> whose product actually fits that customer is the
            one offered.
          </p>
        )}

        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-ink-muted">
            No defaults yet. Every customer sees the full list of lenders that
            cover them.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[1080px] text-sm">
              <thead className="bg-surface-muted text-left text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Dealer</th>
                  <th className="px-3 py-2 font-medium">Dealer state</th>
                  <th className="px-3 py-2 font-medium">Dealer city</th>
                  <th className="px-3 py-2 font-medium">Customer state</th>
                  <th className="px-3 py-2 font-medium">Customer city</th>
                  <th className="px-3 py-2 font-medium">Priority</th>
                  <th className="px-3 py-2 font-medium">NBFC</th>
                  <th className="px-3 py-2 font-medium">Loan product</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const stale = r.productStatus !== "active";
                  return (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-3 py-2 text-ink-muted">{i + 1}</td>
                      <td className="px-3 py-2">
                        {r.dealerName ??
                          r.dealerCode ?? (
                            <span className="text-ink-muted">Any dealer</span>
                          )}
                      </td>
                      <td className="px-3 py-2">
                        {r.state ?? (
                          <span className="text-ink-muted">Any</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r.city ?? (
                          <span className="text-ink-muted">
                            {r.state ? "All cities" : "Any"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r.customerState ?? (
                          <span className="text-ink-muted">Any</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r.customerCity ?? (
                          <span className="text-ink-muted">
                            {r.customerState ? "All cities" : "Any"}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 tabular-nums">{r.priority}</td>
                      <td className="px-3 py-2">
                        {r.nbfcShortName ?? "—"}
                        {r.nbfcCode && (
                          <span className="ml-1 text-xs text-ink-muted">
                            ({r.nbfcCode})
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {r.productName ?? "—"}
                        {stale && (
                          <span
                            className="ml-2 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                            title="This product is no longer active, so the default will not be offered."
                          >
                            <AlertTriangle className="h-3 w-3" />
                            not offered
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => remove(r)}
                          className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
