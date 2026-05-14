"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Search,
  ChevronRight,
  Bookmark,
  Pencil,
  Loader2,
  X,
  Check,
} from "lucide-react";

// ─── Types shared with the dialer modal & /api/ai-dialer/preview ──────

export interface RegionCityPair {
  state: string;
  city: string;
}

export interface RegionSelection {
  /** States selected as a whole — every city in them. */
  states: string[];
  /** Specific {state, city} pairs. Not deduped against `states`. */
  cities: RegionCityPair[];
  /** Optional pincode drill-down. Unused by the current UI but accepted. */
  pincodes: string[];
  /** Saved region groups picked from the Saved Groups tab. */
  groupIds: string[];
}

export const EMPTY_SELECTION: RegionSelection = {
  states: [],
  cities: [],
  pincodes: [],
  groupIds: [],
};

export function isEmptySelection(s: RegionSelection): boolean {
  return (
    s.states.length === 0 &&
    s.cities.length === 0 &&
    s.pincodes.length === 0 &&
    s.groupIds.length === 0
  );
}

// ─── API shapes ────────────────────────────────────────────────────────

interface RegionTreeCity {
  city: string;
  leadCount: number;
  pincodeCount: number;
}
interface RegionTreeState {
  state: string;
  leadCount: number;
  cities: RegionTreeCity[];
}
interface RegionGroupRow {
  id: string;
  name: string;
  description: string | null;
  regions: { state: string; cities?: string[] }[];
  updated_at: string | null;
}

// ─── Component ─────────────────────────────────────────────────────────

export function RegionSelector({
  value,
  onChange,
  onManageGroups,
}: {
  value: RegionSelection;
  onChange: (next: RegionSelection) => void;
  onManageGroups: () => void;
}) {
  const [tab, setTab] = useState<"saved" | "custom">("saved");

  // Refetch on every mount and throw on non-2xx / {success:false} so a
  // transient API error (schema drift while a migration was being applied,
  // a 500 from a bug) can't get cached and strand the selector empty.
  // staleTime stays modest so concurrent re-renders share the result.
  const { data: treeData, isLoading: treeLoading } = useQuery<{
    success: boolean;
    data: RegionTreeState[];
  }>({
    queryKey: ["dealer-leads-regions-tree"],
    queryFn: async () => {
      const res = await fetch("/api/dealer-leads/regions/tree");
      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error?.message ?? json?.error ?? `HTTP ${res.status}`);
      }
      return json;
    },
    staleTime: 10_000,
    refetchOnMount: "always",
    retry: 1,
  });
  const tree: RegionTreeState[] = treeData?.data ?? [];

  const { data: groupsData, isLoading: groupsLoading } = useQuery<{
    success: boolean;
    data: RegionGroupRow[];
  }>({
    queryKey: ["region-groups"],
    queryFn: async () => {
      const res = await fetch("/api/region-groups");
      const json = await res.json();
      if (!res.ok || !json?.success) {
        throw new Error(json?.error?.message ?? json?.error ?? `HTTP ${res.status}`);
      }
      return json;
    },
    staleTime: 10_000,
    refetchOnMount: "always",
    retry: 1,
  });
  const groups: RegionGroupRow[] = groupsData?.data ?? [];

  // Auto-jump to "Saved" if there are groups but nothing selected yet, or
  // "Custom" if no groups exist at all.
  useEffect(() => {
    if (!groupsLoading && groups.length === 0 && tab === "saved") {
      setTab("custom");
    }
  }, [groupsLoading, groups.length, tab]);

  return (
    <div className="region-selector">
      <style jsx global>{`
        .region-selector {
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          background: #ffffff;
          overflow: hidden;
        }
        .region-tabs {
          display: flex;
          gap: 0;
          border-bottom: 1px solid #f3f4f6;
          background: #fafafa;
        }
        .region-tab {
          flex: 1;
          padding: 10px 12px;
          font-size: 12px;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: #6b7280;
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          cursor: pointer;
          transition: color 160ms ease, border-color 160ms ease, background 160ms ease;
        }
        .region-tab:hover {
          color: #111827;
          background: #ffffff;
        }
        .region-tab.is-active {
          color: #059669;
          border-bottom-color: #10b981;
          background: #ffffff;
        }
        .region-body {
          max-height: 320px;
          overflow-y: auto;
        }
        .region-row {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 10px 14px;
          font-size: 13px;
          color: #111827;
          cursor: pointer;
          border-bottom: 1px solid #f9fafb;
          transition: background 120ms ease;
        }
        .region-row:hover {
          background: #f9fafb;
        }
        .region-row.is-checked {
          background: #ecfdf5;
        }
        .region-row .checkbox {
          width: 16px;
          height: 16px;
          border-radius: 4px;
          border: 1.5px solid #d1d5db;
          background: #ffffff;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        .region-row.is-checked .checkbox {
          background: #10b981;
          border-color: #10b981;
          color: white;
        }
        .region-row.is-indeterminate .checkbox {
          background: #ecfdf5;
          border-color: #10b981;
        }
        .region-row.is-indeterminate .checkbox::after {
          content: "";
          width: 8px;
          height: 2px;
          background: #10b981;
          border-radius: 1px;
        }
        .region-search {
          padding: 10px 14px;
          border-bottom: 1px solid #f3f4f6;
          background: #ffffff;
        }
        .region-search input {
          width: 100%;
          padding: 6px 10px 6px 30px;
          font-size: 13px;
          border: 1px solid #e5e7eb;
          border-radius: 8px;
          background: #fafafa;
          outline: none;
        }
        .region-search input:focus {
          background: #ffffff;
          border-color: #d1d5db;
        }
        .region-search-wrap {
          position: relative;
        }
        .region-search-wrap svg {
          position: absolute;
          left: 10px;
          top: 50%;
          transform: translateY(-50%);
          width: 14px;
          height: 14px;
          color: #9ca3af;
        }
        .region-count {
          margin-left: auto;
          font-size: 11px;
          color: #9ca3af;
          font-variant-numeric: tabular-nums;
        }
        .region-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          padding: 10px 14px;
          background: #fafafa;
          border-top: 1px solid #f3f4f6;
          min-height: 38px;
        }
        .region-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 8px 4px 10px;
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 999px;
          font-size: 12px;
          color: #111827;
        }
        .region-chip.is-group {
          background: #eef2ff;
          border-color: #c7d2fe;
          color: #4338ca;
        }
        .region-chip button {
          background: transparent;
          border: none;
          padding: 0;
          color: #9ca3af;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
        }
        .region-chip button:hover {
          color: #ef4444;
        }
        .region-chips .empty {
          color: #9ca3af;
          font-size: 12px;
          padding: 4px 0;
        }
        .region-manage {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 8px 14px;
          font-size: 12px;
          background: #fafafa;
          border-top: 1px solid #f3f4f6;
        }
        .region-manage button {
          color: #4338ca;
          background: transparent;
          border: none;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: 12px;
          font-weight: 500;
        }
        .region-manage button:hover {
          text-decoration: underline;
        }
      `}</style>

      <div className="region-tabs">
        <button
          type="button"
          className={`region-tab ${tab === "saved" ? "is-active" : ""}`}
          onClick={() => setTab("saved")}
        >
          Saved Groups{groups.length > 0 ? ` · ${groups.length}` : ""}
        </button>
        <button
          type="button"
          className={`region-tab ${tab === "custom" ? "is-active" : ""}`}
          onClick={() => setTab("custom")}
        >
          Custom Selection
        </button>
      </div>

      {tab === "saved" ? (
        <SavedGroupsTab
          groups={groups}
          loading={groupsLoading}
          value={value}
          onChange={onChange}
        />
      ) : (
        <CustomTab
          tree={tree}
          loading={treeLoading}
          value={value}
          onChange={onChange}
        />
      )}

      <SelectionChips groups={groups} value={value} onChange={onChange} />

      <div className="region-manage">
        <span className="text-gray-500">
          {isEmptySelection(value)
            ? "No regions selected — all callable leads will be dialed."
            : `${selectionLabel(value, groups)} selected`}
        </span>
        <button type="button" onClick={onManageGroups}>
          <Pencil className="w-3 h-3" />
          Manage groups
        </button>
      </div>
    </div>
  );
}

// ─── Saved Groups tab ──────────────────────────────────────────────────

function SavedGroupsTab({
  groups,
  loading,
  value,
  onChange,
}: {
  groups: RegionGroupRow[];
  loading: boolean;
  value: RegionSelection;
  onChange: (next: RegionSelection) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter(
      (g) =>
        g.name.toLowerCase().includes(q) ||
        (g.description ?? "").toLowerCase().includes(q),
    );
  }, [groups, query]);

  const toggle = (groupId: string) => {
    if (value.groupIds.includes(groupId)) {
      onChange({ ...value, groupIds: value.groupIds.filter((g) => g !== groupId) });
    } else {
      onChange({ ...value, groupIds: [...value.groupIds, groupId] });
    }
  };

  return (
    <>
      <div className="region-search">
        <div className="region-search-wrap">
          <Search />
          <input
            placeholder="Search saved groups…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="region-body">
        {loading ? (
          <div className="px-4 py-6 text-center text-sm text-gray-400">
            <Loader2 className="inline w-3.5 h-3.5 animate-spin mr-2" />
            Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-400">
            {groups.length === 0
              ? "No saved groups yet. Use Manage groups to create one, or pick states & cities under Custom Selection."
              : "No matches."}
          </div>
        ) : (
          filtered.map((g) => {
            const checked = value.groupIds.includes(g.id);
            const summary = g.regions
              .map((r) =>
                !r.cities || r.cities.length === 0
                  ? `${r.state} (all)`
                  : `${r.state} > ${r.cities.length} ${r.cities.length === 1 ? "city" : "cities"}`,
              )
              .join(" · ");
            return (
              <div
                key={g.id}
                className={`region-row ${checked ? "is-checked" : ""}`}
                onClick={() => toggle(g.id)}
              >
                <span className="checkbox">
                  {checked && <Check className="w-3 h-3" />}
                </span>
                <Bookmark className="w-3.5 h-3.5 text-indigo-500" />
                <div className="flex-1 min-w-0">
                  <div className="font-semibold leading-tight truncate">{g.name}</div>
                  <div className="text-[11px] text-gray-500 mt-0.5 truncate">
                    {g.description || summary}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// ─── Custom Selection tab ──────────────────────────────────────────────

function CustomTab({
  tree,
  loading,
  value,
  onChange,
}: {
  tree: RegionTreeState[];
  loading: boolean;
  value: RegionSelection;
  onChange: (next: RegionSelection) => void;
}) {
  const [query, setQuery] = useState("");
  const [expandedState, setExpandedState] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tree;
    return tree
      .map((s) => {
        const stateHit = s.state.toLowerCase().includes(q);
        const matchedCities = s.cities.filter((c) => c.city.toLowerCase().includes(q));
        if (stateHit) return s;
        if (matchedCities.length) return { ...s, cities: matchedCities };
        return null;
      })
      .filter(Boolean) as RegionTreeState[];
  }, [tree, query]);

  const toggleState = (state: string) => {
    const isWhole = value.states.includes(state);
    if (isWhole) {
      onChange({ ...value, states: value.states.filter((s) => s !== state) });
      return;
    }
    // If any cities of this state are already selected, switch to "whole state".
    const cities = value.cities.filter((c) => c.state !== state);
    onChange({ ...value, states: [...value.states, state], cities });
  };

  const toggleCity = (state: string, city: string) => {
    // Picking a specific city promotes us out of "whole state" mode.
    const states = value.states.filter((s) => s !== state);
    const existing = value.cities.find((c) => c.state === state && c.city === city);
    const cities = existing
      ? value.cities.filter((c) => !(c.state === state && c.city === city))
      : [...value.cities, { state, city }];
    onChange({ ...value, states, cities });
  };

  return (
    <>
      <div className="region-search">
        <div className="region-search-wrap">
          <Search />
          <input
            placeholder="Search states or cities…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="region-body">
        {loading ? (
          <div className="px-4 py-6 text-center text-sm text-gray-400">
            <Loader2 className="inline w-3.5 h-3.5 animate-spin mr-2" />
            Loading regions…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-gray-400">
            {tree.length === 0
              ? "No regions found on dialable leads yet."
              : "No matches."}
          </div>
        ) : (
          filtered.map((s) => {
            const wholeChecked = value.states.includes(s.state);
            const selectedCities = value.cities.filter((c) => c.state === s.state);
            const indeterminate = !wholeChecked && selectedCities.length > 0;
            const isExpanded = expandedState === s.state;
            return (
              <div key={s.state}>
                <div
                  className={`region-row ${
                    wholeChecked
                      ? "is-checked"
                      : indeterminate
                        ? "is-indeterminate"
                        : ""
                  }`}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("button")) return;
                    toggleState(s.state);
                  }}
                >
                  <span className="checkbox">
                    {wholeChecked && <Check className="w-3 h-3" />}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setExpandedState(isExpanded ? null : s.state)
                    }
                    className="p-1 -ml-1 text-gray-400 hover:text-gray-700"
                    aria-label={isExpanded ? "Collapse" : "Expand"}
                  >
                    <ChevronRight
                      className={`w-3.5 h-3.5 transition-transform ${
                        isExpanded ? "rotate-90" : ""
                      }`}
                    />
                  </button>
                  <div className="font-semibold">{s.state}</div>
                  <span className="region-count">{s.leadCount} leads</span>
                </div>
                {isExpanded && (
                  <div style={{ background: "#fcfcfd" }}>
                    {s.cities.map((c) => {
                      const cityChecked =
                        wholeChecked ||
                        !!value.cities.find(
                          (sc) => sc.state === s.state && sc.city === c.city,
                        );
                      return (
                        <div
                          key={c.city}
                          className={`region-row ${cityChecked ? "is-checked" : ""}`}
                          style={{ paddingLeft: 38 }}
                          onClick={() => {
                            if (wholeChecked) {
                              // Picking a city when the whole state is on → promote to per-city.
                              const remainingCities = s.cities
                                .filter((cc) => cc.city !== c.city)
                                .map((cc) => ({ state: s.state, city: cc.city }));
                              onChange({
                                ...value,
                                states: value.states.filter((sn) => sn !== s.state),
                                cities: [...value.cities, ...remainingCities],
                              });
                              return;
                            }
                            toggleCity(s.state, c.city);
                          }}
                        >
                          <span className="checkbox">
                            {cityChecked && <Check className="w-3 h-3" />}
                          </span>
                          <div className="flex-1">{c.city}</div>
                          <span className="region-count">{c.leadCount}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// ─── Chips below the body ──────────────────────────────────────────────

function SelectionChips({
  groups,
  value,
  onChange,
}: {
  groups: RegionGroupRow[];
  value: RegionSelection;
  onChange: (next: RegionSelection) => void;
}) {
  const groupMap = useMemo(() => {
    const m = new Map<string, RegionGroupRow>();
    for (const g of groups) m.set(g.id, g);
    return m;
  }, [groups]);

  if (isEmptySelection(value)) {
    return (
      <div className="region-chips">
        <span className="empty">No regions selected</span>
      </div>
    );
  }

  return (
    <div className="region-chips">
      {value.groupIds.map((id) => {
        const g = groupMap.get(id);
        return (
          <span key={`g-${id}`} className="region-chip is-group">
            <Bookmark className="w-3 h-3" />
            {g?.name ?? id}
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...value,
                  groupIds: value.groupIds.filter((x) => x !== id),
                })
              }
              aria-label="Remove"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        );
      })}
      {value.states.map((s) => (
        <span key={`s-${s}`} className="region-chip">
          {s} <span className="text-gray-400">(all)</span>
          <button
            type="button"
            onClick={() =>
              onChange({ ...value, states: value.states.filter((x) => x !== s) })
            }
            aria-label="Remove"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
      {value.cities.map(({ state, city }) => (
        <span key={`c-${state}-${city}`} className="region-chip">
          {state} <ChevronRight className="w-3 h-3 inline text-gray-400" /> {city}
          <button
            type="button"
            onClick={() =>
              onChange({
                ...value,
                cities: value.cities.filter(
                  (c) => !(c.state === state && c.city === city),
                ),
              })
            }
            aria-label="Remove"
          >
            <X className="w-3 h-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

// ─── Misc helpers exported for the modal footer ───────────────────────

export function selectionLabel(
  value: RegionSelection,
  groups: RegionGroupRow[],
): string {
  const parts: string[] = [];
  if (value.groupIds.length) parts.push(`${value.groupIds.length} group${value.groupIds.length === 1 ? "" : "s"}`);
  if (value.states.length) parts.push(`${value.states.length} state${value.states.length === 1 ? "" : "s"}`);
  if (value.cities.length) parts.push(`${value.cities.length} cit${value.cities.length === 1 ? "y" : "ies"}`);
  if (value.pincodes.length) parts.push(`${value.pincodes.length} pincode${value.pincodes.length === 1 ? "" : "s"}`);
  return parts.join(", ");
}

// Hook used by the modal's "Save as group…" affordance. POSTs to
// /api/region-groups, then invalidates the cache so the new group shows
// up in the Saved Groups tab on next render.
export function useSaveAsRegionGroup() {
  const qc = useQueryClient();
  return async (name: string, value: RegionSelection) => {
    // Convert UI selection → group regions shape.
    const byState = new Map<string, Set<string>>();
    for (const s of value.states) {
      if (!byState.has(s)) byState.set(s, new Set());
      // Empty set ⇒ "all cities in state".
    }
    for (const { state, city } of value.cities) {
      const set = byState.get(state) ?? new Set();
      set.add(city);
      byState.set(state, set);
    }
    const regions = Array.from(byState.entries()).map(([state, cities]) => ({
      state,
      cities: Array.from(cities),
    }));
    const res = await fetch("/api/region-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, regions }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      throw new Error(json.error ?? "Failed to save region group");
    }
    qc.invalidateQueries({ queryKey: ["region-groups"] });
    return json.id as string;
  };
}
