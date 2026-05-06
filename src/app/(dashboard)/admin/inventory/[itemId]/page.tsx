"use client";

// Read-only inventory detail card. Shown to admin and (per BRD) re-used as the
// "View Inventory" panel from the Step 4 product review screen.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

interface InventoryItem {
  id: string;
  serial_number: string | null;
  oem_name: string | null;
  hsn_code: string | null;
  asset_category: string;
  asset_type: string;
  model_type: string;
  is_serialized: boolean;
  warranty_months: number;
  status: string;
  warehouse_location: string | null;
  iot_imei_no: string | null;
  batch_number: string | null;
  manufacturing_date: string | null;
  expiry_date: string | null;
  oem_invoice_number: string | null;
  oem_invoice_date: string | null;
  inventory_amount: string | null;
  gst_percent: string | null;
  gst_amount: string | null;
  final_amount: string | null;
  dealer_id: string | null;
  linked_lead_id: string | null;
  created_at: string;
}

export default function InventoryDetailPage() {
  const { itemId } = useParams() as { itemId: string };
  const [item, setItem] = useState<InventoryItem | null>(null);
  const [dealerName, setDealerName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [writeOffOpen, setWriteOffOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/inventory/${itemId}`);
      const json = await res.json();
      if (json.success) {
        setItem(json.data.item);
        setDealerName(json.data.dealer_name);
      } else {
        setError(json.error?.message || "Failed to load");
      }
    } catch {
      setError("Failed to load");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  const handleWriteOff = async () => {
    if (reason.trim().length < 5) {
      setError("Reason must be at least 5 characters");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/inventory/${itemId}/write-off`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const json = await res.json();
      if (json.success) {
        setWriteOffOpen(false);
        setReason("");
        load();
      } else {
        setError(json.error?.message || "Write-off failed");
      }
    } catch {
      setError("Request failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-8">Loading…</div>;
  if (!item) return <div className="p-8 text-red-600">{error || "Not found"}</div>;

  const editable = item.status === "available";

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Inventory item</h1>
          <p className="text-sm text-gray-500 font-mono">{item.id}</p>
        </div>
        <div className="flex gap-2 items-center">
          <StatusBadge status={item.status} />
          <Link
            href="/admin/inventory"
            className="text-sm text-blue-600 hover:underline"
          >
            ← Back
          </Link>
        </div>
      </header>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">
          {error}
        </div>
      )}

      <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <Field label="Serial number" value={item.serial_number || "—"} mono />
          <Field
            label="Dealer"
            value={dealerName || item.dealer_id || "—"}
          />
          <Field label="Category" value={item.asset_category} />
          <Field label="Asset type" value={item.asset_type} />
          <Field label="Model" value={item.model_type} />
          <Field label="OEM" value={item.oem_name || "—"} />
          <Field label="HSN" value={item.hsn_code || "—"} mono />
          <Field label="Warranty" value={`${item.warranty_months} months`} />
          <Field label="Warehouse" value={item.warehouse_location || "—"} />
          <Field label="IoT IMEI" value={item.iot_imei_no || "—"} mono />
          <Field label="Batch number" value={item.batch_number || "—"} />
          <Field
            label="Manufacturing"
            value={item.manufacturing_date?.slice(0, 10) || "—"}
          />
          <Field
            label="Expiry"
            value={item.expiry_date?.slice(0, 10) || "—"}
          />
          <Field
            label="OEM invoice"
            value={`${item.oem_invoice_number || "—"} (${item.oem_invoice_date?.slice(0, 10) || "—"})`}
          />
          <Field
            label="Inventory amount"
            value={`₹${Number(item.inventory_amount ?? 0).toLocaleString("en-IN")}`}
          />
          <Field
            label="GST"
            value={`${item.gst_percent}% / ₹${Number(item.gst_amount ?? 0).toLocaleString("en-IN")}`}
          />
          <Field
            label="Final amount"
            value={`₹${Number(item.final_amount ?? 0).toLocaleString("en-IN")}`}
          />
          {item.linked_lead_id && (
            <Field label="Linked lead" value={item.linked_lead_id} mono />
          )}
        </div>

        <div className="flex gap-3 pt-4 border-t">
          {editable && (
            <Link
              href={`/admin/inventory/${item.id}/edit`}
              className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-bold hover:bg-blue-700"
            >
              Edit
            </Link>
          )}
          {item.status !== "written_off" && item.status !== "sold" && (
            <button
              onClick={() => setWriteOffOpen(true)}
              className="px-4 py-2 bg-red-600 text-white rounded text-sm font-bold hover:bg-red-700"
            >
              Write off
            </button>
          )}
        </div>
      </section>

      {writeOffOpen && (
        <section className="bg-white border border-red-200 rounded-lg p-6 space-y-4">
          <h2 className="font-bold">Write-off reason</h2>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Minimum 5 characters."
            className="w-full border border-gray-300 rounded p-2 text-sm"
          />
          <div className="flex gap-3">
            <button
              disabled={submitting}
              onClick={handleWriteOff}
              className="px-4 py-2 bg-red-600 text-white rounded text-sm font-bold hover:bg-red-700 disabled:opacity-50"
            >
              {submitting ? "Submitting…" : "Confirm write-off"}
            </button>
            <button
              onClick={() => setWriteOffOpen(false)}
              className="px-4 py-2 bg-gray-200 rounded text-sm"
            >
              Cancel
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`font-medium text-gray-900 ${mono ? "font-mono" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    available: "bg-emerald-100 text-emerald-800",
    reserved: "bg-amber-100 text-amber-800",
    sold: "bg-blue-100 text-blue-800",
    written_off: "bg-gray-100 text-gray-600",
    transferred_in: "bg-cyan-100 text-cyan-800",
    transferred_out: "bg-purple-100 text-purple-800",
  };
  return (
    <span
      className={`px-3 py-1 rounded-full text-xs font-bold uppercase ${
        map[status] || "bg-gray-100 text-gray-700"
      }`}
    >
      {status}
    </span>
  );
}
