'use client';

import { useEffect, useState } from 'react';
import {
  X as XIcon,
  Package,
  MapPin,
  Calendar,
  Cpu,
  ShieldCheck,
  Layers,
  Hash,
  IndianRupee,
} from 'lucide-react';

type InventoryItem = {
  id: string;
  product_name: string;
  sku: string;
  category: string;
  quantity_available: number;
  quantity_reserved: number;
  quantity_sold: number;
  unit_price: number;
  warehouse_location: string | null;
  received_at: string | null;
  is_new: boolean;
  status: 'in_stock' | 'low_stock' | 'out_of_stock';
};

type SerialRow = {
  id: string;
  serial_number: string | null;
  status: string;
  iot_enabled: boolean;
  iot_imei_no: string | null;
  soc_percent: number | null;
  soc_last_sync_at: string | null;
  warehouse_location: string | null;
  physical_condition: string | null;
  star_rating: number | null;
  material_code: string | null;
  batch_number: string | null;
  voltage_v: number | null;
  capacity_ah: number | null;
  unit_price: number;
  allocated_to_dealer_at: string | null;
  sold_at: string | null;
  dispatch_date: string | null;
  oem_invoice_number: string | null;
  oem_invoice_date: string | null;
  oem_warranty_expiry: string | null;
  oem_warranty_months: number | null;
  created_at: string | null;
};

type SerializedResponse = {
  kind: 'serialized';
  sku: string;
  category: string;
  truncated: boolean;
  limit: number;
  serials: SerialRow[];
};

type ParaphernaliaResponse = {
  kind: 'paraphernalia';
  sku: string;
  category: string;
  item_label: string | null;
  available_qty: number;
  reserved_qty: number;
  sold_qty: number;
  unit_cost: number;
  last_upload_at: string | null;
  serials: never[];
};

type DetailResponse = SerializedResponse | ParaphernaliaResponse;

function fmtDate(iso: string | null) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

function fmtINR(n: number) {
  return `₹${(n || 0).toLocaleString('en-IN')}`;
}

function statusPill(status: string) {
  const s = status.toLowerCase();
  if (s === 'available')
    return { label: 'Available', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' };
  if (s === 'reserved')
    return { label: 'Reserved', cls: 'bg-amber-50 text-amber-700 ring-amber-200' };
  if (s === 'sold' || s === 'dispatched')
    return {
      label: s.charAt(0).toUpperCase() + s.slice(1),
      cls: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
    };
  return { label: status, cls: 'bg-gray-50 text-gray-700 ring-gray-200' };
}

function categoryPillClass(category: string) {
  const c = category.toLowerCase();
  if (c === 'battery') return 'bg-blue-100 text-blue-800';
  if (c === 'charger') return 'bg-amber-100 text-amber-800';
  if (c === 'paraphernalia') return 'bg-purple-100 text-purple-800';
  return 'bg-gray-100 text-gray-800';
}

export default function DealerInventoryDetailModal({
  item,
  onClose,
}: {
  item: InventoryItem | null;
  onClose: () => void;
}) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/dealer/inventory/serials?category=${encodeURIComponent(item.category)}&sku=${encodeURIComponent(item.sku)}`,
        );
        const json = await res.json();
        if (cancelled) return;
        if (json.success) setData(json.data as DetailResponse);
        else setError(json.error?.message || 'Failed to load product details');
      } catch {
        if (!cancelled) setError('Failed to load product details');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [item]);

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [item, onClose]);

  if (!item) return null;

  const totalStockValue = item.unit_price * item.quantity_available;
  const isPara = item.category.toLowerCase() === 'paraphernalia';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="dealer-inv-detail-title"
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start sm:items-center justify-center p-4 overflow-auto"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl max-w-4xl w-full shadow-2xl overflow-hidden my-8"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Gradient header */}
        <div className="relative px-6 py-5 text-white bg-gradient-to-br from-emerald-600 via-emerald-500 to-brand-600 overflow-hidden">
          <div className="absolute inset-0 opacity-10 pointer-events-none">
            <div className="absolute -top-10 -right-10 w-44 h-44 rounded-full bg-white" />
            <div className="absolute -bottom-12 -left-8 w-40 h-40 rounded-full bg-white" />
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute top-3 right-3 w-8 h-8 rounded-lg bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors"
          >
            <XIcon className="w-4 h-4" />
          </button>
          <div className="relative flex items-start gap-3">
            <div className="w-11 h-11 rounded-xl bg-white/20 backdrop-blur flex items-center justify-center flex-shrink-0">
              <Package className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${categoryPillClass(item.category)}`}
                >
                  {item.category}
                </span>
                {item.is_new && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-white/20 text-white">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-300 animate-pulse" />
                    New
                  </span>
                )}
              </div>
              <h2
                id="dealer-inv-detail-title"
                className="text-xl sm:text-2xl font-black tracking-tight truncate"
              >
                {item.product_name}
              </h2>
              <div className="text-xs font-medium opacity-90 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono">{item.sku}</span>
                {item.warehouse_location && (
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="w-3 h-3" /> {item.warehouse_location}
                  </span>
                )}
                {item.received_at && (
                  <span className="inline-flex items-center gap-1">
                    <Calendar className="w-3 h-3" /> Last received {fmtDate(item.received_at)}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* KPI strip */}
        <div className="px-6 pt-5">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Kpi
              label="Available"
              value={String(item.quantity_available)}
              tone="emerald"
            />
            <Kpi
              label="Reserved"
              value={String(item.quantity_reserved)}
              tone="amber"
            />
            <Kpi label="Sold" value={String(item.quantity_sold)} tone="indigo" />
            <Kpi label="Stock Value" value={fmtINR(totalStockValue)} tone="brand" />
          </div>
        </div>

        {/* Body */}
        <div className="px-6 pb-6 pt-5 space-y-5">
          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 flex items-center justify-between gap-3">
              <span>{error}</span>
              <button
                onClick={() => {
                  setError(null);
                  setData(null);
                  // Re-trigger by toggling — change item key via parent or just re-fetch:
                  if (item) {
                    setLoading(true);
                    fetch(
                      `/api/dealer/inventory/serials?category=${encodeURIComponent(item.category)}&sku=${encodeURIComponent(item.sku)}`,
                    )
                      .then((r) => r.json())
                      .then((j) => {
                        if (j.success) setData(j.data);
                        else setError(j.error?.message || 'Failed to load');
                      })
                      .catch(() => setError('Failed to load'))
                      .finally(() => setLoading(false));
                  }
                }}
                className="text-xs font-semibold text-red-700 hover:underline"
              >
                Retry
              </button>
            </div>
          )}

          {loading && !data && <SkeletonBody />}

          {data?.kind === 'paraphernalia' && (
            <div className="rounded-2xl border border-purple-100 bg-purple-50 p-5 text-sm text-purple-900">
              <div className="font-bold mb-1">Quantity-tracked stock</div>
              <p className="text-purple-800/80 text-xs leading-relaxed">
                Paraphernalia items are tracked by quantity, not individual serial numbers.
                Use the totals above for stock decisions.
              </p>
              <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
                <KV label="Item Label" value={data.item_label || '—'} />
                <KV label="Unit Cost" value={fmtINR(data.unit_cost)} />
                <KV label="Last Upload" value={fmtDate(data.last_upload_at)} />
              </div>
            </div>
          )}

          {data?.kind === 'serialized' && (
            <SerializedSection data={data} />
          )}
        </div>
      </div>
    </div>
  );
}

function SerializedSection({ data }: { data: SerializedResponse }) {
  if (data.serials.length === 0) {
    return (
      <div className="rounded-xl border border-gray-100 bg-gray-50 p-8 text-center text-sm text-gray-500">
        No serial-level records found for this product.
      </div>
    );
  }

  // Pull a few specs from the first serial (they're consistent within a model).
  const first = data.serials[0];
  const specs: { label: string; value: string }[] = [];
  if (first.voltage_v != null) specs.push({ label: 'Voltage', value: `${first.voltage_v} V` });
  if (first.capacity_ah != null)
    specs.push({ label: 'Capacity', value: `${first.capacity_ah} Ah` });
  if (first.star_rating != null)
    specs.push({ label: 'Star Rating', value: `★ ${first.star_rating}` });
  if (first.physical_condition)
    specs.push({ label: 'Condition', value: first.physical_condition });

  return (
    <>
      {specs.length > 0 && (
        <div className="rounded-xl border border-gray-100 bg-gradient-to-r from-gray-50 to-white p-4">
          <div className="text-[10px] font-bold uppercase tracking-widest text-gray-500 mb-2 flex items-center gap-1.5">
            <Cpu className="w-3 h-3" /> Specs
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {specs.map((s) => (
              <div key={s.label} className="flex items-center gap-2">
                <span className="text-xs text-gray-500">{s.label}:</span>
                <span className="font-bold text-gray-900">{s.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-2xl border border-gray-100 bg-white shadow-sm overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 bg-gray-50">
          <div className="flex items-center gap-2 text-sm font-bold text-gray-700">
            <Hash className="w-4 h-4" /> Serial-level units
            <span className="text-xs font-medium text-gray-500">
              ({data.serials.length}
              {data.truncated ? `+ of many — capped at ${data.limit}` : ''})
            </span>
          </div>
        </div>
        <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 sticky top-0">
              <tr className="border-b border-gray-100">
                <th className="px-4 py-2 text-left text-[11px] font-bold uppercase tracking-wider text-gray-500">
                  Serial
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-bold uppercase tracking-wider text-gray-500">
                  Status
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-bold uppercase tracking-wider text-gray-500">
                  IMEI / IoT
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-bold uppercase tracking-wider text-gray-500">
                  Warehouse
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-bold uppercase tracking-wider text-gray-500">
                  Allocated
                </th>
                <th className="px-4 py-2 text-right text-[11px] font-bold uppercase tracking-wider text-gray-500">
                  Unit Price
                </th>
                <th className="px-4 py-2 text-left text-[11px] font-bold uppercase tracking-wider text-gray-500">
                  Warranty
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.serials.map((s) => {
                const pill = statusPill(s.status);
                return (
                  <tr key={s.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-mono text-xs text-gray-900">
                      {s.serial_number || '—'}
                      {s.material_code && (
                        <div className="text-[10px] text-gray-400 mt-0.5">
                          MAT {s.material_code}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold ring-1 ring-inset ${pill.cls}`}
                      >
                        {pill.label}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700">
                      {s.iot_enabled ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="font-mono">{s.iot_imei_no || '—'}</span>
                          {s.soc_percent != null && (
                            <span className="text-[10px] text-emerald-600 font-bold">
                              SOC {s.soc_percent}%
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700">
                      {s.warehouse_location || '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700">
                      {fmtDate(s.allocated_to_dealer_at)}
                    </td>
                    <td className="px-4 py-3 text-right text-xs font-bold text-gray-900">
                      {fmtINR(s.unit_price)}
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-700">
                      {s.oem_warranty_expiry ? (
                        <div className="flex items-center gap-1">
                          <ShieldCheck className="w-3 h-3 text-emerald-600" />
                          {fmtDate(s.oem_warranty_expiry)}
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data.truncated && (
          <div className="px-4 py-2 bg-amber-50 border-t border-amber-100 text-[11px] text-amber-800">
            Showing first {data.limit} units. Refine your view or contact support to export
            the full list.
          </div>
        )}
      </div>
    </>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'emerald' | 'amber' | 'indigo' | 'brand';
}) {
  const toneCls: Record<typeof tone, string> = {
    emerald: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700',
    indigo: 'bg-indigo-50 text-indigo-700',
    brand: 'bg-gradient-to-br from-brand-50 to-emerald-50 text-brand-700',
  };
  const Icon =
    tone === 'brand' ? IndianRupee : tone === 'indigo' ? Layers : Package;
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2.5">
        <div className={`rounded-xl p-2 ${toneCls[tone]}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0">
          <div className="text-lg font-extrabold text-gray-900 truncate">{value}</div>
          <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400">
            {label}
          </div>
        </div>
      </div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/60 border border-purple-100 px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-purple-700/70">
        {label}
      </div>
      <div className="text-sm font-bold text-purple-900 mt-0.5 truncate">{value}</div>
    </div>
  );
}

function SkeletonBody() {
  return (
    <div className="space-y-4">
      <div className="h-12 rounded-xl bg-gray-100 animate-pulse" />
      <div className="rounded-2xl border border-gray-100 overflow-hidden">
        <div className="h-10 bg-gray-100 animate-pulse" />
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-14 border-t border-gray-100 bg-gray-50/50 animate-pulse" />
        ))}
      </div>
    </div>
  );
}
