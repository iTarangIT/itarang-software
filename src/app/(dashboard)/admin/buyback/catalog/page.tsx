"use client";

/**
 * The battery price book (M16), restyled onto the shared buyback UI kit
 * (design handoff, iTarang Portal.dc.html `scrCatalog`, lines 968-981).
 *
 * The hard part of this screen is not the table — it is the FEAR. An admin who
 * believes that dropping the Dead price by ₹200 might quietly re-price a request
 * a dealer already accepted will simply never touch the catalog, and the prices
 * go stale, which is the exact failure the weekly review nudge exists to prevent.
 *
 * It cannot happen: a battery line copies its price and its
 * price_book_version_at_create when the line is created, and every screen,
 * document and report reads the line's own copy. So the screen says so, in
 * plain words, next to the thing it is reassuring them about — once at the top,
 * and again inside the edit panel where the hesitation actually occurs.
 *
 * DealTable's row shape has no colSpan/expand-row concept, so the price
 * history + edit form (previously two extra <tr> injected under the variant's
 * row) now live in a Card that appears BELOW the table when a row is clicked —
 * all the same logic (addVariant/saveEdit/loadHistory/deactivate), same
 * fields, just reached by clicking the row instead of a dedicated "Edit"
 * cell. The table itself keeps only the brief's 6 columns: Variant · Capacity
 * · Unit price · Buyback·Working · Buyback·Dead · Status — the last of which
 * keeps its own quick Active/Retire toggle, since that one action doesn't
 * need the expanded panel.
 *
 * DATA-BINDING NOTE — "Capacity" has no field of its own in catalog_variants;
 * the schema's only capacity-shaped column is `ah` (already part of the
 * Variant label). This column renders that same `ah` again, alone, so an
 * admin scanning capacities across many rows doesn't have to parse it back
 * out of the compound "60V 120Ah" label each time.
 */

import { useEffect, useState } from "react";

import { Card, DealTable, EmptyState, PageHeader } from "@/components/buyback/ui";
import type { DealTableHead, DealTableRow } from "@/components/buyback/ui";
import { inr } from "@/lib/buyback/format";

/**
 * Mirrors PRICE_REVIEW_INTERVAL_DAYS in lib/buyback/catalog.ts, which cannot be
 * imported here: that module owns the `db` client, and one import would drag the
 * postgres driver into the browser bundle.
 */
const PRICE_REVIEW_INTERVAL_DAYS = 7;

interface Variant {
  id: string;
  type: string;
  chemistry: string | null;
  voltage: string;
  ah: string;
  unit_price: string | null;
  est_buyback_price_working: string | null;
  est_buyback_price_dead: string | null;
  price_book_version: number;
  active: boolean;
  open_lines?: number;
}

interface HistoryRow {
  id: string;
  price_book_version: number;
  unit_price: string | null;
  est_buyback_price_working: string | null;
  est_buyback_price_dead: string | null;
  changed_by_name: string | null;
  note: string | null;
  created_at: string;
}

const EMPTY_FORM = {
  voltage: "",
  ah: "",
  chemistry: "Li-ion",
  unit_price: "",
  est_buyback_price_working: "",
  est_buyback_price_dead: "",
};

/** Trims a trailing ".00" so 60.00 → "60" but 51.20 → "51.2". */
const trim = (value: string | number) => {
  const n = Number(value);
  return Number.isFinite(n) ? String(Number(n.toFixed(2))) : String(value);
};

/** "60V 120Ah Li-ion" — the same label the seed and the dealer's picker use. */
const label = (f: typeof EMPTY_FORM) => `${trim(f.voltage)}V ${trim(f.ah)}Ah ${f.chemistry}`.trim();

/** "" → undefined, so an untouched field stays NULL rather than becoming 0. */
const num = (value: string) => (value.trim() === "" ? undefined : Number(value));

const NO_OPEN_REQUEST_IMPACT =
  "Changing a price here only affects requests raised from now on. Open requests keep the price they were quoted — every battery line stores its own copy, and the price-book version it came from.";

const HEADS: DealTableHead[] = [
  { label: "Variant" },
  { label: "Capacity" },
  { label: "Unit price", align: "right" },
  { label: "Buyback · Working", align: "right" },
  { label: "Buyback · Dead", align: "right" },
  { label: "Status" },
];

export default function BuybackCatalogPage() {
  const [variants, setVariants] = useState<Variant[]>([]);
  const [days, setDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);

  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ working: "", dead: "", note: "" });

  // Which variant's panel (edit form + price history) is open below the
  // table — set by clicking its row.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [history, setHistory] = useState<Record<string, HistoryRow[]>>({});

  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // ?all=1: a retired variant must stay visible, or an admin cannot tell the
      // difference between "we never priced that battery" and "we stopped buying it".
      const res = await fetch("/api/admin/buyback/catalog?all=1");
      const json = await res.json();
      if (cancelled) return;
      setVariants(json?.data?.variants ?? []);
      setDays(json?.data?.days_since_review ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const reviewDue = days === null || days >= PRICE_REVIEW_INTERVAL_DAYS;

  const markReviewed = async () => {
    setBusy(true);
    await fetch("/api/admin/buyback/catalog/review", { method: "POST" });
    setBusy(false);
    reload();
  };

  const addVariant = async () => {
    setBusy(true);
    setError(null);

    const res = await fetch("/api/admin/buyback/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: label(form),
        chemistry: form.chemistry.trim() || undefined,
        voltage: Number(form.voltage),
        ah: Number(form.ah),
        unit_price: num(form.unit_price),
        est_buyback_price_working: num(form.est_buyback_price_working),
        est_buyback_price_dead: num(form.est_buyback_price_dead),
      }),
    });

    const json = await res.json();
    setBusy(false);

    if (!json?.success) {
      setError(json?.error?.message ?? "Could not add the variant.");
      return;
    }

    setForm(EMPTY_FORM);
    setAddOpen(false);
    reload();
  };

  const startEdit = (v: Variant) => {
    setEditId(v.id);
    setError(null);
    setEdit({
      working: v.est_buyback_price_working ? trim(v.est_buyback_price_working) : "",
      dead: v.est_buyback_price_dead ? trim(v.est_buyback_price_dead) : "",
      note: "",
    });
  };

  const saveEdit = async (v: Variant) => {
    setBusy(true);
    setError(null);

    const res = await fetch(`/api/admin/buyback/catalog/${v.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        est_buyback_price_working: num(edit.working),
        est_buyback_price_dead: num(edit.dead),
        note: edit.note.trim() || undefined,
      }),
    });

    const json = await res.json();
    setBusy(false);

    if (!json?.success) {
      setError(json?.error?.message ?? "Could not save the new prices.");
      return;
    }

    setEditId(null);
    // The cached history for this row is now a version out of date; refetch it.
    await loadHistory(v.id, true);
    reload();
  };

  const loadHistory = async (id: string, force = false) => {
    if (history[id] && !force) return;
    const res = await fetch(`/api/admin/buyback/catalog/${id}`);
    const json = await res.json();
    setHistory((h) => ({ ...h, [id]: json?.data?.history ?? [] }));
  };

  const toggleExpand = async (id: string) => {
    const next = expandedId === id ? null : id;
    setExpandedId(next);
    setEditId(null);
    if (next) await loadHistory(next);
  };

  const deactivate = async (v: Variant) => {
    const open = v.open_lines ?? 0;
    const warning =
      open > 0
        ? `${v.type} is on ${open} open request line${open === 1 ? "" : "s"}. Retiring it does NOT affect them — they keep the price they were quoted. It only stops dealers picking this battery on NEW requests.\n\nRetire it?`
        : `Retire ${v.type}? Dealers will no longer be able to pick it on new requests.`;

    if (!window.confirm(warning)) return;

    setBusy(true);
    await fetch(`/api/admin/buyback/catalog/${v.id}`, { method: "DELETE" });
    setBusy(false);
    reload();
  };

  const field = (key: keyof typeof EMPTY_FORM, text: string, placeholder = "") => (
    <label className="block">
      <span className="text-xs font-semibold text-slate-600">{text}</span>
      <input
        value={form[key]}
        placeholder={placeholder}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
      />
    </label>
  );

  const rows: DealTableRow[] = variants.map((v) => ({
    key: v.id,
    onClick: () => toggleExpand(v.id),
    ariaLabel: `${expandedId === v.id ? "Collapse" : "Expand"} ${v.type}`,
    cells: [
      <div key="variant">
        <div className={`font-bold ${v.active ? "text-slate-900" : "text-slate-400"}`}>
          {trim(v.voltage)}V {trim(v.ah)}Ah
        </div>
        <div className="text-[11.5px] text-slate-400">
          {(v.chemistry ?? v.type.replace(/^[\d.]+V\s*\d+Ah\s*/, "").replace(/[()]/g, "")) || "—"}
          {" · v"}
          {v.price_book_version}
        </div>
      </div>,
      <span key="capacity" className="text-slate-600">
        {trim(v.ah)}Ah
      </span>,
      <span key="unit" className="text-right tabular-nums text-slate-700">
        {inr(v.unit_price)}
      </span>,
      <span key="working" className="text-right font-semibold tabular-nums text-green-700">
        {inr(v.est_buyback_price_working)}
      </span>,
      <span key="dead" className="text-right font-semibold tabular-nums text-red-700">
        {inr(v.est_buyback_price_dead)}
      </span>,
      v.active ? (
        <button
          key="status"
          onClick={(e) => {
            e.stopPropagation();
            deactivate(v);
          }}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-full bg-green-100 px-2.5 py-[3px] text-[11px] font-bold text-green-700 disabled:opacity-50"
          title="Retire this variant — it disappears from new intake only"
        >
          Active
        </button>
      ) : (
        <span
          key="status"
          className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-[3px] text-[11px] font-bold text-slate-500"
          title="Retired — hidden from new intake"
        >
          Retired
        </span>
      ),
    ],
  }));

  const expanded = variants.find((v) => v.id === expandedId) ?? null;

  return (
    <div className="bg-bb-bg px-6 py-6">
      <div className="mx-auto max-w-[1180px]">
        <PageHeader
          title="Battery Catalog"
          sub="Every Voltage + Ah is a separate variant, priced independently by condition"
          right={
            <button
              onClick={() => {
                setAddOpen(true);
                setError(null);
              }}
              className="rounded-lg bg-green-600 px-3.5 py-2 text-[12.5px] font-semibold text-white hover:bg-green-700"
            >
              + Add variant
            </button>
          }
        />

        {/* The nudge. Scrap prices move; a catalog nobody has looked at is quietly
            mispricing every new request — which never crashes, and so goes unnoticed. */}
        {!loading && reviewDue && (
          <div className="mb-4 flex items-center justify-between gap-4 rounded-[10px] border border-amber-300 bg-amber-50 px-4 py-3">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-amber-700">
                Price review due
              </div>
              <p className="mt-0.5 text-[13px] text-amber-900">
                {days === null
                  ? "These prices have never been reviewed. Every new request is being quoted against numbers nobody has checked."
                  : `Prices were last reviewed ${days} day${days === 1 ? "" : "s"} ago. Scrap prices move — new requests are being quoted against these numbers.`}
              </p>
            </div>
            <button
              onClick={markReviewed}
              disabled={busy}
              className="shrink-0 rounded-lg bg-amber-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:bg-amber-200"
            >
              Mark reviewed
            </button>
          </div>
        )}

        {!loading && !reviewDue && days !== null && (
          <div className="mb-4 rounded-[10px] border border-gray-200 bg-white px-4 py-2.5 text-xs text-slate-500">
            Prices reviewed {days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}.
          </div>
        )}

        <div className="mb-4 rounded-[10px] border border-gray-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-600">
          <b className="text-slate-800">Editing a price is safe.</b> {NO_OPEN_REQUEST_IMPACT}
        </div>

        {error && !addOpen && !expandedId && <p className="mb-4 text-sm text-red-600">{error}</p>}

        {!loading && variants.length === 0 ? (
          <EmptyState
            icon="🔋"
            title="No variants yet"
            body="A dealer cannot raise a buyback request until there is at least one."
          />
        ) : (
          <Card>
            <DealTable
              heads={HEADS}
              rows={rows}
              loading={loading ? "Loading…" : undefined}
              empty={!loading ? "No variants yet." : undefined}
            />
          </Card>
        )}

        {expanded && (
          <Card title={`${expanded.type} — details`} className="mt-4">
            <div className="p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-slate-500">
                  {expanded.open_lines
                    ? `On ${expanded.open_lines} open request line${expanded.open_lines === 1 ? "" : "s"} right now.`
                    : "Not on any open request line right now."}
                </div>
                {editId !== expanded.id && (
                  <button
                    onClick={() => startEdit(expanded)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                  >
                    Edit prices
                  </button>
                )}
              </div>

              {editId === expanded.id && (
                <div className="mt-3 rounded-lg border border-gray-200 bg-slate-50 p-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block">
                      <span className="text-xs font-semibold text-slate-600">
                        Buyback · Working
                      </span>
                      <input
                        value={edit.working}
                        inputMode="numeric"
                        onChange={(e) => setEdit((s) => ({ ...s, working: e.target.value }))}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums"
                      />
                    </label>
                    <label className="block">
                      <span className="text-xs font-semibold text-slate-600">Buyback · Dead</span>
                      <input
                        value={edit.dead}
                        inputMode="numeric"
                        onChange={(e) => setEdit((s) => ({ ...s, dead: e.target.value }))}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm tabular-nums"
                      />
                    </label>
                    <label className="block sm:col-span-2">
                      <span className="text-xs font-semibold text-slate-600">
                        Why (goes on the price history)
                      </span>
                      <input
                        value={edit.note}
                        placeholder="Scrap lithium down 8% this week"
                        onChange={(e) => setEdit((s) => ({ ...s, note: e.target.value }))}
                        className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </label>
                  </div>

                  <p className="mt-2 text-xs text-slate-500">
                    Saving publishes <b>v{expanded.price_book_version + 1}</b> of the price book.{" "}
                    {NO_OPEN_REQUEST_IMPACT}
                  </p>

                  {error && <div className="mt-2 text-xs text-red-600">{error}</div>}

                  <div className="mt-3 flex justify-end gap-2">
                    <button
                      onClick={() => setEditId(null)}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => saveEdit(expanded)}
                      disabled={busy || (!edit.working.trim() && !edit.dead.trim())}
                      className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-green-700 disabled:bg-slate-200 disabled:text-slate-400"
                    >
                      {busy ? "Saving…" : "Save"}
                    </button>
                  </div>
                </div>
              )}

              <div className="mt-4 text-[11px] font-bold uppercase tracking-wide text-slate-400">
                Price history
              </div>

              {!history[expanded.id] ? (
                <div className="py-3 text-xs text-slate-400">Loading…</div>
              ) : history[expanded.id].length === 0 ? (
                <div className="py-3 text-xs text-slate-400">No recorded changes yet.</div>
              ) : (
                <table className="mt-2 w-full text-xs">
                  <thead>
                    <tr className="text-left text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      <th className="py-1.5 pr-4">Version</th>
                      <th className="py-1.5 pr-4 text-right">Working</th>
                      <th className="py-1.5 pr-4 text-right">Dead</th>
                      <th className="py-1.5 pr-4">Changed by</th>
                      <th className="py-1.5 pr-4">When</th>
                      <th className="py-1.5">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history[expanded.id].map((h) => (
                      <tr key={h.id} className="border-t border-slate-200/70">
                        <td className="py-1.5 pr-4 font-bold text-slate-600">
                          v{h.price_book_version}
                        </td>
                        <td className="py-1.5 pr-4 text-right tabular-nums text-slate-700">
                          {inr(h.est_buyback_price_working)}
                        </td>
                        <td className="py-1.5 pr-4 text-right tabular-nums text-slate-700">
                          {inr(h.est_buyback_price_dead)}
                        </td>
                        <td className="py-1.5 pr-4 text-slate-500">{h.changed_by_name ?? "—"}</td>
                        <td className="py-1.5 pr-4 text-slate-500">
                          {new Date(h.created_at).toLocaleDateString("en-IN")}
                        </td>
                        <td className="py-1.5 text-slate-500">{h.note ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <p className="mt-2 text-xs text-slate-400">
                A request quoted at v2 is still worth what v2 said, whatever the catalog says today.
              </p>
            </div>
          </Card>
        )}
      </div>

      {addOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white p-5 shadow-xl">
            <div className="text-sm font-bold text-slate-900">Add a battery variant</div>
            <p className="mt-1 text-xs text-slate-500">
              Every voltage + capacity combination is its own variant — a shared price band across
              two different batteries is exactly the ambiguity the buyback removes.
            </p>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {field("voltage", "Voltage (V)", "60")}
              {field("ah", "Capacity (Ah)", "120")}
              <div className="sm:col-span-2">{field("chemistry", "Chemistry", "Li-ion")}</div>
              {field("est_buyback_price_working", "Working buyback ₹/unit", "5200")}
              {field("est_buyback_price_dead", "Dead buyback ₹/unit", "3100")}
              <div className="sm:col-span-2">
                {field("unit_price", "OEM list price ₹ (reference only)", "53000")}
              </div>
            </div>

            {form.voltage && form.ah && (
              <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                Dealers will see this as <b className="text-slate-700">{label(form)}</b>.
              </div>
            )}

            {error && <div className="mt-3 text-xs text-red-600">{error}</div>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => {
                  setAddOpen(false);
                  setError(null);
                }}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600"
              >
                Cancel
              </button>
              <button
                onClick={addVariant}
                disabled={busy || !Number(form.voltage) || !Number(form.ah)}
                className="rounded-lg bg-green-600 px-4 py-2 text-xs font-semibold text-white hover:bg-green-700 disabled:bg-slate-200 disabled:text-slate-400"
              >
                {busy ? "Adding…" : "Add variant"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
