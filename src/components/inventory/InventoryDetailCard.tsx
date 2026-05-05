"use client";

// BRD V2 §5.0.5 — Battery / Charger Detail Card.
// Read-only modal body. Loaded from /api/inventory/[serial]/card.

import { useEffect, useState } from "react";
import {
  Loader2,
  Battery,
  ShieldCheck,
  Phone,
  Star,
  Package,
  Building2,
  Activity,
  Banknote,
  Calendar,
  AlertCircle,
} from "lucide-react";

interface DetailCard {
  serial_number: string | null;
  inventory_id: string;
  imei_id: string | null;
  iot_enabled: boolean;
  material_code: string | null;
  category: string | null;
  sub_category: string | null;
  model_number: string | null;
  product_name: string | null;
  voltage_v: number | null;
  capacity_ah: number | null;
  star_rating: number | null;
  physical_condition: string | null;
  supplier_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  invoice_value: string | null;
  inventory_age_days: number | null;
  soc_percent: string | null;
  soc_last_sync_at: string | null;
  oem_warranty_date: string | null;
  oem_warranty_months: number | null;
  oem_warranty_expiry: string | null;
  oem_warranty_clauses: string | null;
  batch_reference: string | null;
  warehouse_location: string | null;
  status: string;
  dealer: { business_entity_name: string | null; city?: string; state?: string } | null;
  linked_lead: { id: string; full_name: string | null; owner_name: string | null; kyc_status: string } | null;
  warranty: {
    id: string;
    warranty_start_date: string | null;
    warranty_end_date: string | null;
    warranty_status: string | null;
  } | null;
  history: { at: string; label: string; detail: string; actor?: string | null }[];
}

export default function InventoryDetailCard({ serial }: { serial: string }) {
  const [data, setData] = useState<DetailCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/inventory/${encodeURIComponent(serial)}/card`,
        );
        const json = await res.json();
        if (cancelled) return;
        if (json.success) setData(json.data);
        else setError(json.error?.message || "Failed to load");
      } catch {
        if (!cancelled) setError("Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serial]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-[#0047AB]" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-6 text-sm text-red-700 bg-red-50">
        <AlertCircle className="w-4 h-4 inline mr-1" />
        {error ?? "No data"}
      </div>
    );
  }

  return (
    <div className="p-6 space-y-5 max-h-[80vh] overflow-y-auto">
      {/* Identity strip */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-4 border-b border-gray-100">
        <div>
          <p className="text-[10px] uppercase tracking-wider font-bold text-gray-400">
            Serial
          </p>
          <p className="text-xl font-mono font-black text-gray-900">
            {data.serial_number}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {data.product_name ?? data.model_number}
            {data.voltage_v && data.capacity_ah
              ? ` · ${data.voltage_v}V / ${data.capacity_ah}Ah`
              : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StarRating value={data.star_rating} />
          <StatusPill status={data.status} />
        </div>
      </div>

      {/* IoT + Identity */}
      <Section icon={<Phone className="w-4 h-4" />} title="IoT & Identity">
        <KV label="IoT Enabled" value={data.iot_enabled ? "Yes" : "No"} />
        <KV label="IMEI" value={data.imei_id ?? "—"} mono />
        <KV label="Material Code" value={data.material_code ?? "—"} mono />
        <KV
          label="Current SOC"
          value={
            data.soc_percent
              ? `${data.soc_percent}%${
                  data.soc_last_sync_at
                    ? ` · synced ${fmtDate(data.soc_last_sync_at)}`
                    : ""
                }`
              : "N/A"
          }
        />
      </Section>

      {/* Product classification */}
      <Section icon={<Package className="w-4 h-4" />} title="Classification">
        <KV label="Category" value={data.category ?? "—"} />
        <KV label="Sub-Category" value={data.sub_category ?? "—"} />
        <KV label="Model" value={data.model_number ?? "—"} />
        <KV label="Condition" value={data.physical_condition ?? "—"} />
      </Section>

      {/* Dealer + Lead */}
      <Section icon={<Building2 className="w-4 h-4" />} title="Allocation">
        <KV label="Dealer" value={data.dealer?.business_entity_name ?? "—"} />
        <KV
          label="Linked Lead"
          value={
            data.linked_lead
              ? `${data.linked_lead.full_name ?? data.linked_lead.owner_name ?? "—"} (${data.linked_lead.kyc_status})`
              : "—"
          }
        />
        <KV label="Warehouse" value={data.warehouse_location ?? "—"} />
        <KV label="Inventory Age" value={ageBadge(data.inventory_age_days)} />
      </Section>

      {/* OEM / Invoice */}
      <Section icon={<Banknote className="w-4 h-4" />} title="OEM & Invoice">
        <KV label="Supplier / OEM" value={data.supplier_name ?? "—"} />
        <KV label="Invoice Number" value={data.invoice_number ?? "—"} mono />
        <KV label="Invoice Date (Sold to Dealer)" value={fmtDate(data.invoice_date)} />
        <KV
          label="Invoice Value"
          value={
            data.invoice_value
              ? `₹${Number(data.invoice_value).toLocaleString("en-IN")}`
              : "—"
          }
        />
        <KV label="Batch / PO" value={data.batch_reference ?? "—"} />
      </Section>

      {/* OEM Warranty */}
      <Section icon={<ShieldCheck className="w-4 h-4" />} title="OEM Warranty">
        <KV label="Warranty Date" value={fmtDate(data.oem_warranty_date)} />
        <KV
          label="Warranty Period"
          value={
            data.oem_warranty_months
              ? `${data.oem_warranty_months} months`
              : "—"
          }
        />
        <KV label="Expiry" value={fmtDate(data.oem_warranty_expiry)} />
        <KV
          label="Clauses"
          full
          value={
            data.oem_warranty_clauses ??
            "No OEM clauses recorded — contact supplier directly."
          }
        />
      </Section>

      {/* Customer warranty */}
      {data.warranty && (
        <Section icon={<Calendar className="w-4 h-4" />} title="Customer Warranty">
          <KV label="Warranty ID" value={data.warranty.id} mono />
          <KV label="Status" value={data.warranty.warranty_status ?? "—"} />
          <KV
            label="Coverage"
            value={`${fmtDate(data.warranty.warranty_start_date)} → ${fmtDate(
              data.warranty.warranty_end_date,
            )}`}
          />
        </Section>
      )}

      {/* History */}
      <Section icon={<Activity className="w-4 h-4" />} title="Status History">
        {data.history.length === 0 ? (
          <p className="text-xs text-gray-400 col-span-2">No history recorded.</p>
        ) : (
          <div className="col-span-2 space-y-2">
            {data.history.map((h, i) => (
              <div
                key={`${h.at}-${i}`}
                className="flex items-start gap-3 text-xs p-3 rounded-xl bg-gray-50"
              >
                <div className="w-2 h-2 rounded-full bg-[#0047AB] mt-1.5 flex-shrink-0" />
                <div className="flex-1">
                  <p className="font-bold text-gray-900">
                    {h.label}{" "}
                    <span className="font-medium text-gray-400">·</span>{" "}
                    <span className="font-medium text-gray-500">
                      {fmtDateTime(h.at)}
                    </span>
                  </p>
                  <p className="text-gray-600 mt-0.5">{h.detail}</p>
                  {h.actor && (
                    <p className="text-[10px] text-gray-400 mt-0.5">
                      By {h.actor}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────────

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <span className="w-7 h-7 rounded-lg bg-[#0047AB]/10 text-[#0047AB] flex items-center justify-center">
          {icon}
        </span>
        <h3 className="font-bold text-sm text-gray-900">{title}</h3>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 pl-9">
        {children}
      </div>
    </section>
  );
}

function KV({
  label,
  value,
  mono,
  full,
}: {
  label: string;
  value: string | React.ReactNode;
  mono?: boolean;
  full?: boolean;
}) {
  return (
    <div className={full ? "sm:col-span-2" : ""}>
      <p className="text-[10px] uppercase tracking-wider font-bold text-gray-400">
        {label}
      </p>
      <p
        className={`text-xs text-gray-900 mt-0.5 ${
          mono ? "font-mono" : "font-medium"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function StarRating({ value }: { value: number | null }) {
  if (value === null || value === undefined) {
    return <span className="text-[10px] text-gray-400">No rating</span>;
  }
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={`w-3.5 h-3.5 ${
            n <= value ? "fill-amber-400 text-amber-400" : "text-gray-300"
          }`}
        />
      ))}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    available: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
    reserved: "bg-amber-50 text-amber-700 ring-amber-600/20",
    dispatched: "bg-blue-50 text-blue-700 ring-blue-600/20",
    sold: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
    write_off: "bg-gray-100 text-gray-600 ring-gray-600/20",
    in_stock: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
    transferred_out: "bg-purple-50 text-purple-700 ring-purple-600/20",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ring-1 ring-inset ${
        map[status] || "bg-gray-100 text-gray-600 ring-gray-600/20"
      }`}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}

function ageBadge(days: number | null): React.ReactNode {
  if (days === null || days === undefined) return "—";
  let cls = "text-emerald-700";
  if (days > 180) cls = "text-red-700 font-bold";
  else if (days > 90) cls = "text-orange-700 font-bold";
  return <span className={cls}>{days} day{days === 1 ? "" : "s"}</span>;
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}
function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Sentinels — let importers know icon set without runtime cost.
void Battery;
