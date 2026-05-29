"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  X,
  Plus,
  Trash2,
  Loader2,
  ChevronRight,
  Pencil,
  Check,
} from "lucide-react";

interface RegionGroupRow {
  id: string;
  name: string;
  description: string | null;
  regions: { state: string; cities?: string[] }[];
  updated_at: string | null;
}

interface RegionTreeCity {
  city: string;
  leadCount: number;
}
interface RegionTreeState {
  state: string;
  leadCount: number;
  cities: RegionTreeCity[];
}

export function RegionGroupManager({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ success: boolean; data: RegionGroupRow[] }>({
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
    enabled: isOpen,
  });
  const groups = data?.data ?? [];

  const { data: treeData } = useQuery<{ success: boolean; data: RegionTreeState[] }>({
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
    enabled: isOpen,
  });
  const tree: RegionTreeState[] = treeData?.data ?? [];

  const [editingId, setEditingId] = useState<string | "new" | null>(null);

  if (!isOpen) return null;

  const remove = async (id: string) => {
    if (!confirm("Delete this region group?")) return;
    await fetch(`/api/region-groups/${id}`, { method: "DELETE" });
    qc.invalidateQueries({ queryKey: ["region-groups"] });
  };

  return (
    <div className="rg-manager-root">
      <style jsx global>{`
        .rg-manager-root {
          position: fixed;
          inset: 0;
          z-index: 60;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
          background: rgba(17, 24, 39, 0.55);
          backdrop-filter: blur(6px) saturate(120%);
        }
        .rg-manager-card {
          width: 100%;
          max-width: 720px;
          max-height: 80vh;
          display: flex;
          flex-direction: column;
          background: #ffffff;
          border-radius: 18px;
          border: 1px solid #e5e7eb;
          box-shadow: 0 24px 60px -20px rgba(15, 23, 42, 0.25);
          overflow: hidden;
        }
        .rg-list-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          border-bottom: 1px solid #f3f4f6;
          font-size: 13px;
        }
        .rg-list-row:hover {
          background: #fafafa;
        }
        .rg-icon-btn {
          background: transparent;
          border: none;
          padding: 6px;
          color: #6b7280;
          cursor: pointer;
          border-radius: 6px;
        }
        .rg-icon-btn:hover {
          background: #f3f4f6;
          color: #111827;
        }
        .rg-icon-btn.danger:hover {
          color: #ef4444;
          background: #fef2f2;
        }
      `}</style>

      <div onClick={onClose} style={{ position: "absolute", inset: 0 }} />
      <div className="rg-manager-card relative">
        <div className="px-6 py-5 flex items-start justify-between border-b border-gray-100">
          <div>
            <h3 className="text-lg font-bold text-gray-900">Saved region groups</h3>
            <p className="text-xs text-gray-500 mt-1">
              Reusable region selections, visible to everyone on the team.
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 -m-2 text-gray-400 hover:text-gray-700 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {editingId !== null ? (
            <GroupEditor
              groupId={editingId === "new" ? null : editingId}
              initial={
                editingId === "new"
                  ? null
                  : groups.find((g) => g.id === editingId) ?? null
              }
              tree={tree}
              onDone={() => {
                setEditingId(null);
                qc.invalidateQueries({ queryKey: ["region-groups"] });
              }}
            />
          ) : isLoading ? (
            <div className="px-6 py-8 text-center text-sm text-gray-400">
              <Loader2 className="inline w-4 h-4 animate-spin mr-2" />
              Loading…
            </div>
          ) : groups.length === 0 ? (
            <div className="px-6 py-8 text-center text-sm text-gray-500">
              No groups yet. Create one to share with the team.
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.id} className="rg-list-row">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{g.name}</div>
                  <div className="text-[12px] text-gray-500 mt-0.5 truncate">
                    {g.description || summarizeRegions(g.regions)}
                  </div>
                </div>
                <button
                  type="button"
                  className="rg-icon-btn"
                  onClick={() => setEditingId(g.id)}
                  aria-label="Edit"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  className="rg-icon-btn danger"
                  onClick={() => remove(g.id)}
                  aria-label="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>

        {editingId === null && (
          <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-end">
            <button
              type="button"
              onClick={() => setEditingId("new")}
              className="inline-flex items-center gap-2 px-4 py-2 text-[13px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              New group
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function summarizeRegions(regions: RegionGroupRow["regions"]): string {
  return regions
    .map((r) =>
      !r.cities || r.cities.length === 0
        ? `${r.state} (all)`
        : `${r.state} > ${r.cities.join(", ")}`,
    )
    .join(" · ");
}

function GroupEditor({
  groupId,
  initial,
  tree,
  onDone,
}: {
  groupId: string | null;
  initial: RegionGroupRow | null;
  tree: RegionTreeState[];
  onDone: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [regions, setRegions] = useState<{ state: string; cities: string[] }[]>(
    () =>
      (initial?.regions ?? []).map((r) => ({
        state: r.state,
        cities: r.cities ?? [],
      })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const treeMap = useMemo(() => {
    const m = new Map<string, RegionTreeState>();
    for (const s of tree) m.set(s.state, s);
    return m;
  }, [tree]);

  const toggleState = (state: string) => {
    setRegions((prev) => {
      const idx = prev.findIndex((r) => r.state === state);
      if (idx === -1) return [...prev, { state, cities: [] }];
      return prev.filter((_, i) => i !== idx);
    });
  };

  const toggleCity = (state: string, city: string) => {
    setRegions((prev) => {
      const idx = prev.findIndex((r) => r.state === state);
      if (idx === -1) return [...prev, { state, cities: [city] }];
      const entry = prev[idx];
      const has = entry.cities.includes(city);
      const cities = has
        ? entry.cities.filter((c) => c !== city)
        : [...entry.cities, city];
      const next = [...prev];
      next[idx] = { state, cities };
      return next;
    });
  };

  const isStatePicked = (state: string) =>
    regions.some((r) => r.state === state);
  const isCityPicked = (state: string, city: string) => {
    const r = regions.find((x) => x.state === state);
    if (!r) return false;
    if (r.cities.length === 0) return true; // "all" mode
    return r.cities.includes(city);
  };

  const submit = async () => {
    setError(null);
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    if (regions.length === 0) {
      setError("Pick at least one state");
      return;
    }
    setBusy(true);
    try {
      const body = JSON.stringify({
        name: name.trim(),
        description: description.trim() || null,
        regions,
      });
      const res = await fetch(
        groupId ? `/api/region-groups/${groupId}` : "/api/region-groups",
        {
          method: groupId ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body,
        },
      );
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(json.error ?? "Failed to save");
        setBusy(false);
        return;
      }
      onDone();
    } catch (err: any) {
      setError(err.message ?? "Failed to save");
      setBusy(false);
    }
  };

  return (
    <div className="px-6 py-5 space-y-4">
      <div>
        <label className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">
          Name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Delhi NCR"
          className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-gray-400"
        />
      </div>
      <div>
        <label className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">
          Description (optional)
        </label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this group covers"
          className="mt-1 w-full px-3 py-2 text-sm border border-gray-200 rounded-lg outline-none focus:border-gray-400"
        />
      </div>
      <div>
        <label className="text-[11px] uppercase tracking-wide font-semibold text-gray-500">
          Regions
        </label>
        <div className="mt-1 border border-gray-200 rounded-lg max-h-72 overflow-y-auto">
          {tree.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-gray-400">
              No regions on dialable leads yet.
            </div>
          ) : (
            tree.map((s) => {
              const picked = isStatePicked(s.state);
              return (
                <div key={s.state}>
                  <div
                    className="flex items-center gap-3 px-4 py-2 border-b border-gray-50 cursor-pointer hover:bg-gray-50"
                    onClick={() => toggleState(s.state)}
                  >
                    <span
                      className="w-4 h-4 rounded border-2 flex items-center justify-center"
                      style={{
                        background: picked ? "#10b981" : "#fff",
                        borderColor: picked ? "#10b981" : "#d1d5db",
                        color: "#fff",
                      }}
                    >
                      {picked && <Check className="w-3 h-3" />}
                    </span>
                    <span className="font-semibold text-sm">{s.state}</span>
                    <span className="ml-auto text-[11px] text-gray-400">
                      {s.leadCount} leads
                    </span>
                  </div>
                  {picked && (
                    <div className="pl-10 bg-gray-50/50">
                      {s.cities.map((c) => {
                        const cityPicked = isCityPicked(s.state, c.city);
                        return (
                          <div
                            key={c.city}
                            className="flex items-center gap-3 px-4 py-1.5 cursor-pointer hover:bg-gray-100/60"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleCity(s.state, c.city);
                            }}
                          >
                            <span
                              className="w-3.5 h-3.5 rounded border-2 flex items-center justify-center"
                              style={{
                                background: cityPicked ? "#10b981" : "#fff",
                                borderColor: cityPicked ? "#10b981" : "#d1d5db",
                                color: "#fff",
                              }}
                            >
                              {cityPicked && <Check className="w-2.5 h-2.5" />}
                            </span>
                            <span className="text-[13px]">{c.city}</span>
                            <span className="ml-auto text-[11px] text-gray-400">
                              {c.leadCount}
                            </span>
                          </div>
                        );
                      })}
                      <div className="px-4 py-1.5 text-[11px] text-gray-400 border-t border-gray-100">
                        Leave all cities unchecked = include every city in this
                        state.
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {error && (
        <div className="text-[12px] text-rose-600 bg-rose-50 border border-rose-100 px-3 py-2 rounded-md">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          className="px-4 py-2 text-[13px] text-gray-600 hover:text-gray-900 cursor-pointer disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="inline-flex items-center gap-2 px-4 py-2 text-[13px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg cursor-pointer disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Check className="w-3.5 h-3.5" />
          )}
          {groupId ? "Save changes" : "Create group"}
        </button>
      </div>
    </div>
  );
}
