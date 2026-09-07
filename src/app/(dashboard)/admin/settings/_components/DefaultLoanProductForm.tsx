"use client";

// E-282/E-283/E-286 — Settings → Loan Product. One table of pinned defaults
// plus an add row. A rule names a dealer, a dealer LOCATION, or both; every
// field it leaves blank means "any".
//
// The location is the DEALER's own (accounts.state / accounts.city), not the
// customer's — so the state and city lists are built from the dealers this
// screen already loaded, NOT from country-state-city. That is deliberate: a
// dealer's address is captured at onboarding and may not be spelled the way
// the country-state-city package spells it, so offering every city in India
// here would mostly offer cities no rule could ever match. The dealer picker
// rides /api/admin/dealers, whose `id` IS the dealer code stored on the rule.
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

type Row = {
  id: number;
  dealerCode: string | null;
  dealerName: string | null;
  state: string | null;
  city: string | null;
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

/** How a rule reads in one line, for toasts and confirm dialogs. */
function describeScope(
  dealerLabel: string | null,
  state: string | null,
  cities: string[],
): string {
  const where = !state
    ? null
    : cities.length === 0
      ? `dealers in ${state}`
      : cities.length === 1
        ? `dealers in ${cities[0]}, ${state}`
        : `dealers in ${cities.length} cities of ${state}`;
  if (dealerLabel && where) return `${dealerLabel} — ${where}`;
  if (dealerLabel) return `${dealerLabel} (wherever it is)`;
  return where ?? "everywhere";
}

export function DefaultLoanProductForm() {
  const qc = useQueryClient();

  const [dealerCode, setDealerCode] = useState("");
  const [state, setState] = useState("");
  const [cities, setCities] = useState<string[]>([]);
  const [stateWide, setStateWide] = useState(false);
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
  // "Any location" is only a valid rule when a dealer scopes it — the API
  // rejects a rule that names neither. Drop back to a located rule if the
  // dealer is cleared while no state is selected.
  const anyLocation = !!dealerCode && !state;
  useEffect(() => {
    if (!dealerCode && !state) setStateWide(false);
  }, [dealerCode, state]);

  const selectedNbfc = data?.nbfcs.find((n) => String(n.id) === nbfcId) ?? null;
  const selectedDealer =
    dealers.find((d) => d.id === dealerCode) ?? null;

  const effectiveState = state || null;
  // Empty = the rule covers the whole state (or carries no location at all)
  // and is written as a single row. Otherwise one row is written per entry.
  const effectiveCities = useMemo(
    () => (!effectiveState || stateWide ? [] : cities),
    [effectiveState, stateWide, cities],
  );

  // A rule that names BOTH a dealer and a location only matches while that
  // dealer sits in it. Naming a location the dealer is not in produces a rule
  // that can never fire, so the form says so before it is saved.
  const dealerLocationConflict = useMemo(() => {
    if (!selectedDealer || !effectiveState) return false;
    if (norm(selectedDealer.state ?? "") !== norm(effectiveState)) return true;
    if (effectiveCities.length === 0) return false;
    return !effectiveCities.some(
      (c) => norm(c) === norm(selectedDealer.city ?? ""),
    );
  }, [selectedDealer, effectiveState, effectiveCities]);

  const blockedWarning =
    !!selectedNbfc && (blockedQuery.data ?? []).includes(selectedNbfc.id);

  const canSave =
    !!nbfcId &&
    !!productId &&
    // A rule must name a dealer or a location (the API enforces this too).
    (!!dealerCode || !!effectiveState) &&
    // With a state chosen, pick at least one city or say the whole state.
    (!effectiveState || stateWide || cities.length > 0) &&
    !saving;

  function resetForm() {
    setDealerCode("");
    setState("");
    setCities([]);
    setStateWide(false);
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
          // One rule per city; an empty list keeps the state-wide /
          // any-location shape a single row.
          cities: effectiveCities,
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
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Add a default</h2>

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
                {dealersQuery.isLoading
                  ? "Loading…"
                  : dealerCode
                    ? "Any location"
                    : "Select state…"}
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

          <label className="space-y-1">
            <span className="text-xs font-medium text-ink-muted">Priority</span>
            <input
              type="number"
              min={0}
              max={1000}
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            />
            <span className="block text-xs text-ink-muted">
              Highest wins. On a tie, a dealer rule beats a location rule and an
              exact city beats a whole state.
            </span>
          </label>
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

        {effectiveCities.length > 1 && (
          <p className="text-sm text-ink-muted">
            This saves <strong>{effectiveCities.length}</strong> rules — one per
            city — all pinned to the same lender and product. Each can be
            removed on its own below.
          </p>
        )}

        {anyLocation && (
          <p className="text-sm text-ink-muted">
            This rule applies to every customer of{" "}
            <strong>{selectedDealer?.business_entity_name ?? "the dealer"}</strong>
            , wherever that dealer is. Add a state to narrow it.
          </p>
        )}

        {!dealerCode && !state && (
          <p className="text-sm text-ink-muted">
            Choose a dealer, a dealer location, or both — a default has to be
            scoped to at least one of them.
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
              , not in the location you picked, so this rule can never match.
              Drop the location to pin the dealer wherever it is, or pick the
              dealer&apos;s own location — you can still save this mapping now.
            </span>
          </div>
        )}

        <Button onClick={save} disabled={!canSave}>
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Plus className="mr-2 h-4 w-4" />
          )}
          {effectiveCities.length > 1
            ? `Save ${effectiveCities.length} defaults`
            : "Save default"}
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
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-surface-muted text-left text-xs uppercase tracking-wide text-ink-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Dealer</th>
                  <th className="px-3 py-2 font-medium">Dealer state</th>
                  <th className="px-3 py-2 font-medium">Dealer city</th>
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
