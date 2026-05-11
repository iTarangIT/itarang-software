"use client";

// BRD V2 §5.0 / §5.1 — Admin Product Master.
// Catalog of every battery, charger, and paraphernalia SKU iTarang sells.
// CRUD APIs already exist at /api/admin/product-master/* — this page is the
// browser surface admins use to manage them.

import { useEffect, useState, type ReactNode } from "react";
import { Loader2, Package, Plus, X, AlertTriangle, CheckCircle2, Pencil } from "lucide-react";

const INVENTORY_CATEGORIES = ["3W", "2W", "4W", "Inverter", "Solar", "Other"] as const;
const BATTERY_CHEMISTRIES = ["LFP", "NMC", "Lead Acid", "Other"] as const;
const CHARGING_TYPES = ["Standard", "Fast", "Smart", "Solar-Compatible"] as const;

type Tab = "batteries" | "chargers" | "paraphernalia";
type StatusFilter = "all" | "active" | "inactive";

interface BatteryRow {
  id: string;
  model_id: string;
  model_name: string;
  compatible_categories: string[];
  compatible_sub_categories: string[];
  voltage_v: string | null;
  capacity_ah: string | null;
  battery_chemistry: string | null;
  warranty_months: number;
  iot_compatible: boolean;
  compatible_charger_models: string[];
  status: string;
}

interface ChargerRow {
  id: string;
  model_id: string;
  model_name: string;
  output_voltage_v: string | null;
  output_current_a: string | null;
  charging_type: string | null;
  compatible_battery_models: string[];
  base_price: string | null;
  warranty_months: number;
  status: string;
}

interface ParaphernaliaRow {
  id: string;
  item_type_code: string;
  display_label: string;
  compatible_categories: string[];
  max_qty_per_lead: number;
  harness_variant: boolean;
  status: string;
}

type AnyRow = BatteryRow | ChargerRow | ParaphernaliaRow;

const TAB_META: Record<Tab, { label: string; endpoint: string; idField: keyof AnyRow }> = {
  batteries: { label: "Batteries", endpoint: "/api/admin/product-master/batteries", idField: "model_id" },
  chargers: { label: "Chargers", endpoint: "/api/admin/product-master/chargers", idField: "model_id" },
  paraphernalia: {
    label: "Paraphernalia",
    endpoint: "/api/admin/product-master/paraphernalia",
    idField: "item_type_code",
  },
};

export default function ProductMasterPage() {
  const [tab, setTab] = useState<Tab>("batteries");
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [rows, setRows] = useState<AnyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [editing, setEditing] = useState<AnyRow | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Cross-tab options for the multi-selects (chargers list ↔ batteries list).
  const [allBatteryModels, setAllBatteryModels] = useState<{ model_id: string; model_name: string }[]>([]);
  const [allChargerModels, setAllChargerModels] = useState<{ model_id: string; model_name: string }[]>([]);

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const url = new URL(TAB_META[tab].endpoint, window.location.origin);
      if (q.trim()) url.searchParams.set("q", q.trim());
      if (statusFilter !== "all") url.searchParams.set("status", statusFilter);
      const res = await fetch(url.toString());
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || "Failed to load");
      setRows(json.data?.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  // Pre-load battery + charger lists once (drives the compatibility multi-selects).
  const reloadCrossLists = async () => {
    try {
      const [b, c] = await Promise.all([
        fetch("/api/admin/product-master/batteries?status=active").then((r) => r.json()),
        fetch("/api/admin/product-master/chargers?status=active").then((r) => r.json()),
      ]);
      if (b.success) {
        setAllBatteryModels((b.data.items as BatteryRow[]).map((x) => ({ model_id: x.model_id, model_name: x.model_name })));
      }
      if (c.success) {
        setAllChargerModels((c.data.items as ChargerRow[]).map((x) => ({ model_id: x.model_id, model_name: x.model_name })));
      }
    } catch {
      // non-fatal — drawer will just show empty lists
    }
  };

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, statusFilter]);

  useEffect(() => {
    const t = setTimeout(reload, 250); // debounce search typing
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  useEffect(() => {
    reloadCrossLists();
  }, []);

  const openNew = () => {
    setEditing(null);
    setDrawerOpen(true);
  };

  const openEdit = (row: AnyRow) => {
    setEditing(row);
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setEditing(null);
  };

  const handleSaved = async (msg: string) => {
    setInfo(msg);
    closeDrawer();
    await reload();
    await reloadCrossLists();
    setTimeout(() => setInfo(null), 4000);
  };

  const toggleStatus = async (row: AnyRow) => {
    const meta = TAB_META[tab];
    const code = row[meta.idField] as string;
    const nextActive = row.status !== "active";
    try {
      const res = nextActive
        ? await fetch(`${meta.endpoint}/${encodeURIComponent(code)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "active" }),
          })
        : await fetch(`${meta.endpoint}/${encodeURIComponent(code)}`, { method: "DELETE" });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || "Failed to toggle");
      setInfo(nextActive ? "Reactivated" : "Marked inactive");
      await reload();
      await reloadCrossLists();
      setTimeout(() => setInfo(null), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to toggle");
    }
  };

  return (
    <div className="min-h-screen bg-[#F8F9FB]">
      <div className="max-w-[1400px] mx-auto px-6 py-8 space-y-6">
        <header>
          <h1 className="text-[28px] font-black text-gray-900 tracking-tight">Product Master</h1>
          <p className="text-sm text-gray-500 mt-1">
            Catalog of battery, charger, and paraphernalia SKUs. Inventory uploads validate against active rows here.
          </p>
        </header>

        {error && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
            <button onClick={() => setError(null)} className="ml-auto text-red-700 hover:text-red-900">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
        {info && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">
            <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{info}</span>
          </div>
        )}

        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm overflow-hidden">
          {/* Tabs */}
          <div className="flex items-center border-b border-gray-100 px-2">
            {(Object.keys(TAB_META) as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-3 text-sm font-bold border-b-2 transition-colors ${
                  tab === t
                    ? "border-[#0047AB] text-[#0047AB]"
                    : "border-transparent text-gray-500 hover:text-gray-800"
                }`}
              >
                {TAB_META[t].label}
              </button>
            ))}
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-3 px-5 py-4 border-b border-gray-100 flex-wrap">
            <input
              type="search"
              placeholder={`Search ${TAB_META[tab].label.toLowerCase()}…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="flex-1 min-w-[200px] border border-gray-200 rounded-lg px-3 py-2 text-sm"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="border border-gray-200 rounded-lg px-3 py-2 text-sm"
            >
              <option value="all">All statuses</option>
              <option value="active">Active only</option>
              <option value="inactive">Inactive only</option>
            </select>
            <button
              onClick={openNew}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[#0047AB] hover:bg-[#003580] text-white rounded-lg font-bold text-sm transition-colors"
            >
              <Plus className="w-4 h-4" />
              New {tab === "paraphernalia" ? "item" : tab === "batteries" ? "battery" : "charger"}
            </button>
          </div>

          {/* Table */}
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-16 text-gray-400 text-sm">
              <Package className="w-10 h-10 mx-auto mb-3 text-gray-300" />
              No {tab} yet. Click <span className="font-bold">+ New</span> to add one.
            </div>
          ) : (
            <div className="overflow-x-auto">
              {tab === "batteries" && <BatteryTable rows={rows as BatteryRow[]} onEdit={openEdit} onToggle={toggleStatus} />}
              {tab === "chargers" && <ChargerTable rows={rows as ChargerRow[]} onEdit={openEdit} onToggle={toggleStatus} />}
              {tab === "paraphernalia" && <ParaTable rows={rows as ParaphernaliaRow[]} onEdit={openEdit} onToggle={toggleStatus} />}
            </div>
          )}
        </div>
      </div>

      {drawerOpen && (
        <FormDrawer
          tab={tab}
          editing={editing}
          allBatteryModels={allBatteryModels}
          allChargerModels={allChargerModels}
          onClose={closeDrawer}
          onSaved={handleSaved}
          onError={setError}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Tables (one per tab — fields differ enough that sharing one is uglier)
// ──────────────────────────────────────────────────────────────────

function BatteryTable({
  rows,
  onEdit,
  onToggle,
}: {
  rows: BatteryRow[];
  onEdit: (r: BatteryRow) => void;
  onToggle: (r: BatteryRow) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500 font-bold">
        <tr>
          <th className="px-4 py-3 text-left">Model ID</th>
          <th className="px-4 py-3 text-left">Name</th>
          <th className="px-4 py-3 text-left">V / Ah</th>
          <th className="px-4 py-3 text-left">Chemistry</th>
          <th className="px-4 py-3 text-right">Warranty</th>
          <th className="px-4 py-3 text-left">IoT</th>
          <th className="px-4 py-3 text-left">Categories</th>
          <th className="px-4 py-3 text-left">Status</th>
          <th className="px-4 py-3 text-right">Actions</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {rows.map((r) => (
          <tr key={r.id} className={r.status === "inactive" ? "opacity-50" : ""}>
            <td className="px-4 py-3 font-mono text-xs">{r.model_id}</td>
            <td className="px-4 py-3 font-medium">{r.model_name}</td>
            <td className="px-4 py-3 text-gray-600">
              {r.voltage_v ? `${r.voltage_v}V` : "—"} / {r.capacity_ah ? `${r.capacity_ah}Ah` : "—"}
            </td>
            <td className="px-4 py-3 text-gray-600">{r.battery_chemistry ?? "—"}</td>
            <td className="px-4 py-3 text-right tabular-nums">{r.warranty_months} mo</td>
            <td className="px-4 py-3">{r.iot_compatible ? "Yes" : "—"}</td>
            <td className="px-4 py-3 text-xs text-gray-600">{(r.compatible_categories || []).join(", ") || "—"}</td>
            <td className="px-4 py-3"><StatusPill status={r.status} /></td>
            <td className="px-4 py-3 text-right">
              <RowActions row={r} onEdit={() => onEdit(r)} onToggle={() => onToggle(r)} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ChargerTable({
  rows,
  onEdit,
  onToggle,
}: {
  rows: ChargerRow[];
  onEdit: (r: ChargerRow) => void;
  onToggle: (r: ChargerRow) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500 font-bold">
        <tr>
          <th className="px-4 py-3 text-left">Model ID</th>
          <th className="px-4 py-3 text-left">Name</th>
          <th className="px-4 py-3 text-left">Output</th>
          <th className="px-4 py-3 text-left">Type</th>
          <th className="px-4 py-3 text-right">Base price</th>
          <th className="px-4 py-3 text-right">Warranty</th>
          <th className="px-4 py-3 text-left">Status</th>
          <th className="px-4 py-3 text-right">Actions</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {rows.map((r) => (
          <tr key={r.id} className={r.status === "inactive" ? "opacity-50" : ""}>
            <td className="px-4 py-3 font-mono text-xs">{r.model_id}</td>
            <td className="px-4 py-3 font-medium">{r.model_name}</td>
            <td className="px-4 py-3 text-gray-600">
              {r.output_voltage_v ? `${r.output_voltage_v}V` : "—"} / {r.output_current_a ? `${r.output_current_a}A` : "—"}
            </td>
            <td className="px-4 py-3 text-gray-600">{r.charging_type ?? "—"}</td>
            <td className="px-4 py-3 text-right tabular-nums">{r.base_price ? `₹${Number(r.base_price).toLocaleString("en-IN")}` : "—"}</td>
            <td className="px-4 py-3 text-right tabular-nums">{r.warranty_months} mo</td>
            <td className="px-4 py-3"><StatusPill status={r.status} /></td>
            <td className="px-4 py-3 text-right">
              <RowActions row={r} onEdit={() => onEdit(r)} onToggle={() => onToggle(r)} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ParaTable({
  rows,
  onEdit,
  onToggle,
}: {
  rows: ParaphernaliaRow[];
  onEdit: (r: ParaphernaliaRow) => void;
  onToggle: (r: ParaphernaliaRow) => void;
}) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-gray-50 text-[10px] uppercase tracking-wider text-gray-500 font-bold">
        <tr>
          <th className="px-4 py-3 text-left">Code</th>
          <th className="px-4 py-3 text-left">Label</th>
          <th className="px-4 py-3 text-left">Categories</th>
          <th className="px-4 py-3 text-right">Max qty / lead</th>
          <th className="px-4 py-3 text-left">Harness variant</th>
          <th className="px-4 py-3 text-left">Status</th>
          <th className="px-4 py-3 text-right">Actions</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-gray-100">
        {rows.map((r) => (
          <tr key={r.id} className={r.status === "inactive" ? "opacity-50" : ""}>
            <td className="px-4 py-3 font-mono text-xs">{r.item_type_code}</td>
            <td className="px-4 py-3 font-medium">{r.display_label}</td>
            <td className="px-4 py-3 text-xs text-gray-600">{(r.compatible_categories || []).join(", ") || "—"}</td>
            <td className="px-4 py-3 text-right tabular-nums">{r.max_qty_per_lead}</td>
            <td className="px-4 py-3">{r.harness_variant ? "Yes" : "—"}</td>
            <td className="px-4 py-3"><StatusPill status={r.status} /></td>
            <td className="px-4 py-3 text-right">
              <RowActions row={r} onEdit={() => onEdit(r)} onToggle={() => onToggle(r)} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusPill({ status }: { status: string }) {
  const cls = status === "active" ? "bg-emerald-50 text-emerald-700" : "bg-gray-100 text-gray-600";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${cls}`}>
      {status}
    </span>
  );
}

function RowActions({ onEdit, onToggle, row }: { onEdit: () => void; onToggle: () => void; row: AnyRow }) {
  return (
    <div className="inline-flex items-center gap-2">
      <button onClick={onEdit} className="text-xs font-bold text-[#0047AB] hover:underline inline-flex items-center gap-1">
        <Pencil className="w-3 h-3" /> Edit
      </button>
      <span className="text-gray-300">·</span>
      <button onClick={onToggle} className="text-xs font-bold text-gray-600 hover:text-gray-900 hover:underline">
        {row.status === "active" ? "Mark inactive" : "Reactivate"}
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Drawer (slide-over create / edit form)
// ──────────────────────────────────────────────────────────────────

function FormDrawer({
  tab,
  editing,
  allBatteryModels,
  allChargerModels,
  onClose,
  onSaved,
  onError,
}: {
  tab: Tab;
  editing: AnyRow | null;
  allBatteryModels: { model_id: string; model_name: string }[];
  allChargerModels: { model_id: string; model_name: string }[];
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const isEdit = editing != null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/30" onClick={onClose} />
      <aside className="w-full max-w-[520px] bg-white shadow-xl flex flex-col">
        <header className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="font-black text-gray-900">
              {isEdit ? "Edit" : "New"} {TAB_META[tab].label.replace(/s$/, "")}
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">BRD V2 §5.0 / §5.1</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {tab === "batteries" && (
            <BatteryForm
              editing={editing as BatteryRow | null}
              allChargerModels={allChargerModels}
              onSaved={onSaved}
              onError={onError}
            />
          )}
          {tab === "chargers" && (
            <ChargerForm
              editing={editing as ChargerRow | null}
              allBatteryModels={allBatteryModels}
              onSaved={onSaved}
              onError={onError}
            />
          )}
          {tab === "paraphernalia" && (
            <ParaForm editing={editing as ParaphernaliaRow | null} onSaved={onSaved} onError={onError} />
          )}
        </div>
      </aside>
    </div>
  );
}

function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <label className="block text-[10px] uppercase tracking-wider font-bold text-gray-500 mb-1">
      {children}
      {hint && <span className="ml-1 text-gray-400 normal-case font-normal tracking-normal">— {hint}</span>}
    </label>
  );
}

function MultiSelectChips({
  options,
  selected,
  onChange,
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (v: string) => {
    if (selected.includes(v)) onChange(selected.filter((x) => x !== v));
    else onChange([...selected, v]);
  };
  if (options.length === 0) {
    return <p className="text-xs text-gray-400">No options yet. Add some first.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = selected.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => toggle(o.value)}
            className={`px-2.5 py-1 rounded-full text-xs font-bold border transition-colors ${
              on
                ? "bg-[#0047AB] text-white border-[#0047AB]"
                : "bg-white text-gray-600 border-gray-200 hover:border-gray-300"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ───── Battery form ─────

function BatteryForm({
  editing,
  allChargerModels,
  onSaved,
  onError,
}: {
  editing: BatteryRow | null;
  allChargerModels: { model_id: string; model_name: string }[];
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const isEdit = editing != null;
  const [modelId, setModelId] = useState(editing?.model_id ?? "");
  const [modelName, setModelName] = useState(editing?.model_name ?? "");
  const [categories, setCategories] = useState<string[]>(editing?.compatible_categories ?? []);
  const [subCategories, setSubCategories] = useState<string>(
    (editing?.compatible_sub_categories ?? []).join(", "),
  );
  const [voltage, setVoltage] = useState(editing?.voltage_v?.toString() ?? "");
  const [capacity, setCapacity] = useState(editing?.capacity_ah?.toString() ?? "");
  const [chemistry, setChemistry] = useState(editing?.battery_chemistry ?? "");
  const [warrantyMonths, setWarrantyMonths] = useState(editing?.warranty_months?.toString() ?? "0");
  const [iotCompatible, setIotCompatible] = useState(editing?.iot_compatible ?? false);
  const [chargerModels, setChargerModels] = useState<string[]>(editing?.compatible_charger_models ?? []);
  const [active, setActive] = useState((editing?.status ?? "active") === "active");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (modelName.trim().length < 1) {
      onError("Model Name is required");
      return;
    }
    if (!isEdit && modelId.trim().length < 1) {
      onError("Model ID is required");
      return;
    }
    const body = {
      modelId: modelId.trim(),
      modelName: modelName.trim(),
      compatibleCategories: categories,
      compatibleSubCategories: subCategories.split(",").map((s) => s.trim()).filter(Boolean),
      voltageV: voltage.trim() ? Number(voltage) : null,
      capacityAh: capacity.trim() ? Number(capacity) : null,
      batteryChemistry: chemistry.trim() || null,
      warrantyMonths: Number(warrantyMonths) || 0,
      iotCompatible,
      compatibleChargerModels: chargerModels,
      status: active ? "active" : "inactive",
    };
    setSubmitting(true);
    try {
      const url = isEdit
        ? `/api/admin/product-master/batteries/${encodeURIComponent(editing!.model_id)}`
        : "/api/admin/product-master/batteries";
      // PATCH doesn't accept modelId — strip it.
      const payload = isEdit ? (() => { const { modelId: _, ...rest } = body; return rest; })() : body;
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || "Save failed");
      onSaved(isEdit ? `Updated ${body.modelId}` : `Created ${body.modelId}`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel hint="immutable after first save">Model ID</FieldLabel>
          <input
            type="text"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            disabled={isEdit}
            placeholder="BAT-51V-105AH-3W"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono disabled:bg-gray-50 disabled:text-gray-500"
          />
        </div>
        <div>
          <FieldLabel>Model name</FieldLabel>
          <input
            type="text"
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            placeholder="51.2V 105Ah LFP"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div>
        <FieldLabel>Compatible categories</FieldLabel>
        <MultiSelectChips
          options={INVENTORY_CATEGORIES.map((c) => ({ value: c, label: c }))}
          selected={categories}
          onChange={setCategories}
        />
      </div>

      <div>
        <FieldLabel hint="comma-separated, e.g. E-Rickshaw, E-Cart">Sub-categories</FieldLabel>
        <input
          type="text"
          value={subCategories}
          onChange={(e) => setSubCategories(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <FieldLabel>Voltage (V)</FieldLabel>
          <input
            type="number"
            step="0.01"
            value={voltage}
            onChange={(e) => setVoltage(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <FieldLabel>Capacity (Ah)</FieldLabel>
          <input
            type="number"
            step="0.01"
            value={capacity}
            onChange={(e) => setCapacity(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <FieldLabel>Warranty (mo)</FieldLabel>
          <input
            type="number"
            min="0"
            max="240"
            value={warrantyMonths}
            onChange={(e) => setWarrantyMonths(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div>
        <FieldLabel>Chemistry</FieldLabel>
        <select
          value={chemistry}
          onChange={(e) => setChemistry(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">Select…</option>
          {BATTERY_CHEMISTRIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div>
        <FieldLabel>Compatible charger models</FieldLabel>
        <MultiSelectChips
          options={allChargerModels.map((c) => ({ value: c.model_id, label: c.model_name }))}
          selected={chargerModels}
          onChange={setChargerModels}
        />
      </div>

      <div className="flex items-center gap-6 pt-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={iotCompatible} onChange={(e) => setIotCompatible(e.target.checked)} />
          <span>IoT compatible</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>{active ? "Active" : "Inactive"}</span>
        </label>
      </div>

      <SaveButton submitting={submitting} onSubmit={submit} isEdit={isEdit} />
    </div>
  );
}

// ───── Charger form ─────

function ChargerForm({
  editing,
  allBatteryModels,
  onSaved,
  onError,
}: {
  editing: ChargerRow | null;
  allBatteryModels: { model_id: string; model_name: string }[];
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const isEdit = editing != null;
  const [modelId, setModelId] = useState(editing?.model_id ?? "");
  const [modelName, setModelName] = useState(editing?.model_name ?? "");
  const [outputV, setOutputV] = useState(editing?.output_voltage_v?.toString() ?? "");
  const [outputA, setOutputA] = useState(editing?.output_current_a?.toString() ?? "");
  const [chargingType, setChargingType] = useState(editing?.charging_type ?? "");
  const [batteryModels, setBatteryModels] = useState<string[]>(editing?.compatible_battery_models ?? []);
  const [basePrice, setBasePrice] = useState(editing?.base_price?.toString() ?? "");
  const [warrantyMonths, setWarrantyMonths] = useState(editing?.warranty_months?.toString() ?? "0");
  const [active, setActive] = useState((editing?.status ?? "active") === "active");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (modelName.trim().length < 1) {
      onError("Model Name is required");
      return;
    }
    if (!isEdit && modelId.trim().length < 1) {
      onError("Model ID is required");
      return;
    }
    const body = {
      modelId: modelId.trim(),
      modelName: modelName.trim(),
      outputVoltageV: outputV.trim() ? Number(outputV) : null,
      outputCurrentA: outputA.trim() ? Number(outputA) : null,
      chargingType: chargingType.trim() || null,
      compatibleBatteryModels: batteryModels,
      basePrice: basePrice.trim() ? Number(basePrice) : null,
      warrantyMonths: Number(warrantyMonths) || 0,
      status: active ? "active" : "inactive",
    };
    setSubmitting(true);
    try {
      const url = isEdit
        ? `/api/admin/product-master/chargers/${encodeURIComponent(editing!.model_id)}`
        : "/api/admin/product-master/chargers";
      const payload = isEdit ? (() => { const { modelId: _, ...rest } = body; return rest; })() : body;
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || "Save failed");
      onSaved(isEdit ? `Updated ${body.modelId}` : `Created ${body.modelId}`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel hint="immutable after first save">Model ID</FieldLabel>
          <input
            type="text"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            disabled={isEdit}
            placeholder="CHR-51V-20A"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-mono disabled:bg-gray-50 disabled:text-gray-500"
          />
        </div>
        <div>
          <FieldLabel>Model name</FieldLabel>
          <input
            type="text"
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            placeholder="Fast Charger 51.2V-20A"
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <FieldLabel>Output (V)</FieldLabel>
          <input
            type="number"
            step="0.01"
            value={outputV}
            onChange={(e) => setOutputV(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <FieldLabel>Output (A)</FieldLabel>
          <input
            type="number"
            step="0.01"
            value={outputA}
            onChange={(e) => setOutputA(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <FieldLabel>Warranty (mo)</FieldLabel>
          <input
            type="number"
            min="0"
            max="240"
            value={warrantyMonths}
            onChange={(e) => setWarrantyMonths(e.target.value)}
            className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
      </div>

      <div>
        <FieldLabel>Charging type</FieldLabel>
        <select
          value={chargingType}
          onChange={(e) => setChargingType(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">Select…</option>
          {CHARGING_TYPES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <div>
        <FieldLabel hint="must agree with battery's compatible_charger_models">Compatible battery models</FieldLabel>
        <MultiSelectChips
          options={allBatteryModels.map((b) => ({ value: b.model_id, label: b.model_name }))}
          selected={batteryModels}
          onChange={setBatteryModels}
        />
      </div>

      <div>
        <FieldLabel hint="₹, used in Step 4 pricing">Base price</FieldLabel>
        <input
          type="number"
          min="0"
          step="0.01"
          value={basePrice}
          onChange={(e) => setBasePrice(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      <div className="flex items-center gap-6 pt-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>{active ? "Active" : "Inactive"}</span>
        </label>
      </div>

      <SaveButton submitting={submitting} onSubmit={submit} isEdit={isEdit} />
    </div>
  );
}

// ───── Paraphernalia form ─────

function ParaForm({
  editing,
  onSaved,
  onError,
}: {
  editing: ParaphernaliaRow | null;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const isEdit = editing != null;
  const [code, setCode] = useState(editing?.item_type_code ?? "");
  const [label, setLabel] = useState(editing?.display_label ?? "");
  const [categories, setCategories] = useState<string[]>(editing?.compatible_categories ?? []);
  const [maxQty, setMaxQty] = useState(editing?.max_qty_per_lead?.toString() ?? "0");
  const [harnessVariant, setHarnessVariant] = useState(editing?.harness_variant ?? false);
  const [active, setActive] = useState((editing?.status ?? "active") === "active");
  const [submitting, setSubmitting] = useState(false);

  // BRD constraint: lowercase, no spaces.
  const codeInvalid = code.length > 0 && !/^[a-z0-9_]+$/.test(code);

  const submit = async () => {
    if (label.trim().length < 1) {
      onError("Display Label is required");
      return;
    }
    if (!isEdit && code.trim().length < 1) {
      onError("Item Type Code is required");
      return;
    }
    if (!isEdit && codeInvalid) {
      onError("Item Type Code must be lowercase letters, digits, and underscores only");
      return;
    }
    const body = {
      itemTypeCode: code.trim(),
      displayLabel: label.trim(),
      compatibleCategories: categories,
      maxQtyPerLead: Number(maxQty) || 0,
      harnessVariant,
      status: active ? "active" : "inactive",
    };
    setSubmitting(true);
    try {
      const url = isEdit
        ? `/api/admin/product-master/paraphernalia/${encodeURIComponent(editing!.item_type_code)}`
        : "/api/admin/product-master/paraphernalia";
      const payload = isEdit ? (() => { const { itemTypeCode: _, ...rest } = body; return rest; })() : body;
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error?.message || "Save failed");
      onSaved(isEdit ? `Updated ${body.itemTypeCode}` : `Created ${body.itemTypeCode}`);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <FieldLabel hint="immutable after first save · lowercase, no spaces">Item Type Code</FieldLabel>
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          disabled={isEdit}
          placeholder="digital_soc"
          className={`w-full border rounded-lg px-3 py-2 text-sm font-mono disabled:bg-gray-50 disabled:text-gray-500 ${
            codeInvalid ? "border-red-300" : "border-gray-200"
          }`}
        />
        {codeInvalid && (
          <p className="text-xs text-red-600 mt-1">Use lowercase letters, digits, and underscores only.</p>
        )}
      </div>

      <div>
        <FieldLabel>Display label</FieldLabel>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Digital SOC"
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      <div>
        <FieldLabel>Compatible categories</FieldLabel>
        <MultiSelectChips
          options={INVENTORY_CATEGORIES.map((c) => ({ value: c, label: c }))}
          selected={categories}
          onChange={setCategories}
        />
      </div>

      <div>
        <FieldLabel hint="upper limit per lead in Step 4">Max qty per lead</FieldLabel>
        <input
          type="number"
          min="0"
          value={maxQty}
          onChange={(e) => setMaxQty(e.target.value)}
          className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      <div className="flex items-center gap-6 pt-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={harnessVariant}
            onChange={(e) => setHarnessVariant(e.target.checked)}
          />
          <span>Harness variant (variant selector instead of qty input)</span>
        </label>
      </div>
      <div className="flex items-center gap-6">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>{active ? "Active" : "Inactive"}</span>
        </label>
      </div>

      <SaveButton submitting={submitting} onSubmit={submit} isEdit={isEdit} />
    </div>
  );
}

function SaveButton({
  submitting,
  onSubmit,
  isEdit,
}: {
  submitting: boolean;
  onSubmit: () => void;
  isEdit: boolean;
}) {
  return (
    <div className="pt-3 border-t border-gray-100">
      <button
        onClick={onSubmit}
        disabled={submitting}
        className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-[#0047AB] hover:bg-[#003580] text-white rounded-xl font-bold text-sm transition-colors disabled:opacity-50"
      >
        {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
        {submitting ? "Saving…" : isEdit ? "Save changes" : "Create"}
      </button>
    </div>
  );
}
