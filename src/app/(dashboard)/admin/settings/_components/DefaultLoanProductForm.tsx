"use client";

// E-282/E-283/E-286/E-290/E-291 — Settings → Loan Product. One table of pinned
// defaults plus an add row.
//
// A rule is exactly ONE OF THREE KINDS, and that is the whole model:
//
//   a dealer          → that dealer, whoever the customer is
//   a customer city   → every customer who lives in that city
//   a customer state  → every customer who lives in that state
//
// THE MOST SPECIFIC RULE WINS — dealer, then city, then state. There is no
// priority number to set and no tie to break: the admin says who a default is
// for, and the ladder decides the order.
//
// Picking a dealer HIDES the location fields. Not because a dealer implies a
// location — since E-291 the location is the CUSTOMER's and a dealer sells to
// customers anywhere — but because a combined "this dealer AND customers in
// Kolkata" would be a fourth kind, and the ladder has no rung for it. The POST
// route enforces the same thing, since it is the real boundary.
//
// THE LOCATION IS THE CUSTOMER'S (leads.state / leads.city), so the state and
// city lists are the full India set from country-state-city — the same source
// the NBFC serviceable-locations picker uses. A default is written about a
// market, and a market can be pinned before the first lead from it arrives, so
// narrowing these lists to places iTarang already has leads or dealers in
// would only block rules that are legitimately written ahead of demand.
//
// This never widens coverage. nbfc_loan_products.active_locations is the
// LENDER's own declaration of where it can serve, and the BRE applies it to
// leads.state / leads.city BEFORE any pin is consulted — so by the time a rule
// is read, every remaining lender already serves this customer and the pin
// only chooses among them. A rule naming a city no lender covers is inert
// rather than wrong.
//
// The dealer picker rides /api/admin/dealers, whose `id` IS the dealer code
// stored on the rule.
//
// Several cities can be pinned at once. A rule row still carries ONE city —
// that is what the resolver and the partial unique index key on — so the POST
// fans the selection out into one rule per city. Each stays independently
// listed and removable, and the table still reads top-down as the resolution
// order.

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CityMultiCombobox } from "@/components/admin/nbfc/StateCityPicker";
import { useIndiaLocationData } from "@/lib/location/useIndiaLocationData";

/** Matches the cap the POST route enforces on the city list. */
const MAX_ROWS_PER_SAVE = 200;

type Row = {
  id: number;
  dealerCode: string | null;
  dealerName: string | null;
  state: string | null;
  city: string | null;
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

/** Which of the three kinds a rule is — the label on its badge. */
type Kind = "Dealer" | "City" | "State";

function kindOf(dealerCode: string | null, city: string | null): Kind {
  if (dealerCode) return "Dealer";
  if (city) return "City";
  return "State";
}

const KIND_STYLE: Record<Kind, string> = {
  Dealer: "bg-sky-100 text-sky-800",
  City: "bg-violet-100 text-violet-800",
  State: "bg-slate-100 text-slate-700",
};

/**
 * How a rule reads in one line — used for the live preview under the form, the
 * save toast, the remove confirm, and the "Applies to" cell of the table, so
 * all four say the same thing in the same words.
 */
function describeScope(
  dealerLabel: string | null,
  state: string | null,
  cities: string[],
): string {
  if (dealerLabel) return `${dealerLabel} — whoever the customer is`;
  if (!state) return "everyone";
  if (cities.length === 0) return `customers in ${state}`;
  if (cities.length === 1) return `customers in ${cities[0]}, ${state}`;
  return `customers in ${cities.length} cities of ${state}`;
}

export function DefaultLoanProductForm() {
  const qc = useQueryClient();

  const [dealerCode, setDealerCode] = useState("");
  const [state, setState] = useState("");
  const [cities, setCities] = useState<string[]>([]);
  const [stateWide, setStateWide] = useState(false);
  const [nbfcId, setNbfcId] = useState("");
  const [productId, setProductId] = useState("");
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

  // The location is the CUSTOMER's, so the lists are every state and city in
  // India rather than the places iTarang already has dealers or leads in — a
  // default is written about a market and may legitimately be pinned before
  // the first lead from it arrives. Loaded on demand: country-state-city is
  // hundreds of KB and this page should not pay for it at first paint.
  const locations = useIndiaLocationData();

  const stateOptions = useMemo(
    () =>
      [...locations.states].sort((a, b) => a.name.localeCompare(b.name)),
    [locations.states],
  );

  // The picker stores the state NAME (that is what the rule stores and what
  // leads.state is compared against); country-state-city keys its city lookup
  // on the ISO code, so it is resolved back here.
  const stateIso = useMemo(
    () =>
      stateOptions.find((s) => norm(s.name) === norm(state))?.isoCode ?? "",
    [stateOptions, state],
  );

  // The three kinds are mutually exclusive: naming a dealer drops any location
  // that was picked first, so the form can never be left in a state the POST
  // route would silently reinterpret.
  useEffect(() => {
    if (!dealerCode) return;
    setState("");
    setCities([]);
    setStateWide(false);
  }, [dealerCode]);

  const selectedNbfc = data?.nbfcs.find((n) => String(n.id) === nbfcId) ?? null;
  const selectedDealer = dealers.find((d) => d.id === dealerCode) ?? null;

  const effectiveState = dealerCode ? null : state || null;
  // Empty = the rule covers the whole state and is written as a single row.
  // Otherwise one row per city.
  const effectiveCities = useMemo(
    () => (!effectiveState || stateWide ? [] : cities),
    [effectiveState, stateWide, cities],
  );

  const rowCount = Math.max(effectiveCities.length, 1);

  const blockedWarning =
    !!selectedNbfc && (blockedQuery.data ?? []).includes(selectedNbfc.id);

  const scopeChosen = !!dealerCode || !!effectiveState;

  const canSave =
    !!nbfcId &&
    !!productId &&
    // A rule must name a dealer or a location (the API enforces it too).
    scopeChosen &&
    // With a state chosen, pick at least one city or say the whole state.
    (!effectiveState || stateWide || cities.length > 0) &&
    rowCount <= MAX_ROWS_PER_SAVE &&
    !saving;

  function resetForm() {
    setDealerCode("");
    setState("");
    setCities([]);
    setStateWide(false);
    setNbfcId("");
    setProductId("");
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
          // One rule per city; an empty list keeps a state-wide or dealer rule
          // a single row.
          cities: effectiveCities,
          nbfc_id: Number(nbfcId),
          loan_product_id: Number(productId),
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
      row.dealerName ?? row.dealerCode,
      row.state,
      row.city ? [row.city] : [],
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

        {/* ── Who gets this default ────────────────────────────────── */}
        <div className="space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Who gets this default
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
              <span className="block text-xs text-ink-muted">
                {dealerCode
                  ? "One dealer. Clear this to pin a location instead."
                  : "Pick one dealer, or leave it and pin a location below."}
              </span>
            </label>

            {/* A dealer rule and a location rule are never both asked for —
                that is what keeps the rule one of three kinds. */}
            {dealerCode ? (
              <div className="space-y-1 sm:col-span-1 lg:col-span-2">
                <span className="text-xs font-medium text-ink-muted">
                  Customer location
                </span>
                <p className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-ink-muted">
                  Every customer of this dealer, wherever they live.
                </p>
              </div>
            ) : (
              <>
                <label className="space-y-1">
                  <span className="text-xs font-medium text-ink-muted">
                    State
                  </span>
                  <select
                    value={state}
                    onChange={(e) => {
                      setState(e.target.value);
                      setCities([]);
                      if (!e.target.value) setStateWide(false);
                    }}
                    disabled={!locations.loaded}
                    className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                  >
                    <option value="">
                      {locations.loaded ? "Select a state…" : "Loading…"}
                    </option>
                    {stateOptions.map((s) => (
                      <option key={s.isoCode} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <span className="block text-xs text-ink-muted">
                    Where the customer lives, matched against the lead&rsquo;s state.
                  </span>
                </label>

                <div className="space-y-1">
                  <span className="text-xs font-medium text-ink-muted">
                    Cities
                  </span>
                  {stateWide ? (
                    <p className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-ink-muted">
                      All cities in {state || "the state"}
                    </p>
                  ) : (
                    <CityMultiCombobox
                      locations={locations}
                      stateIso={stateIso}
                      value={cities}
                      onChange={setCities}
                    />
                  )}
                  <span className="block text-xs text-ink-muted">
                    {!state
                      ? "Pick a state first."
                      : stateWide
                        ? "Untick below to pin only certain cities."
                        : "Where the customer lives — pick as many as you like; one rule is saved per city."}
                  </span>
                </div>
              </>
            )}
          </div>

          {!dealerCode && state && (
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
              Apply to every customer in the state (a city rule still wins over
              this)
            </label>
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

        {/* The rule in one sentence, before it is saved. */}
        {scopeChosen ? (
          <p className="rounded-lg border border-border bg-surface-muted px-3 py-2 text-sm text-ink">
            {rowCount > 1 ? (
              <>
                Saves <strong>{rowCount}</strong> rules — one per city — for{" "}
              </>
            ) : (
              "This default applies to "
            )}
            <strong>
              {describeScope(
                selectedDealer?.business_entity_name ?? null,
                effectiveState,
                effectiveCities,
              )}
            </strong>
            .
          </p>
        ) : (
          <p className="text-sm text-ink-muted">
            Choose a dealer, or a state and its cities — a default has to be
            scoped to one of them.
          </p>
        )}

        {rowCount > MAX_ROWS_PER_SAVE && (
          <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              {rowCount} cities is more than the {MAX_ROWS_PER_SAVE} rules that
              can be saved at once. Pick fewer.
            </span>
          </div>
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
            Listed in the order they are checked — the most specific rule first.
            The first rule that matches a lead <em>and</em> whose product
            actually fits that customer is the one offered.
          </p>
        )}

        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-ink-muted">
            No defaults yet. Every customer sees the full list of lenders that
            cover them.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-surface-muted text-left text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Applies to</th>
                  <th className="px-3 py-2 font-medium">NBFC</th>
                  <th className="px-3 py-2 font-medium">Loan product</th>
                  <th className="px-3 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const stale = r.productStatus !== "active";
                  const kind = kindOf(r.dealerCode, r.city);
                  return (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-3 py-2 text-ink-muted">{i + 1}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`mr-2 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${KIND_STYLE[kind]}`}
                        >
                          {kind}
                        </span>
                        {describeScope(
                          r.dealerName ?? r.dealerCode,
                          r.state,
                          r.city ? [r.city] : [],
                        )}
                      </td>
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
