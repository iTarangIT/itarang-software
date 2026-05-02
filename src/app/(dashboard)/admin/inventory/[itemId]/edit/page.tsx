"use client";

// Edit non-critical inventory fields per BRD: only warehouse_location and
// iot_imei_no. Serial / category / invoice_date are immutable identity fields.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";

interface Item {
  id: string;
  serial_number: string | null;
  hsn_code: string | null;
  asset_category: string;
  model_type: string;
  warehouse_location: string | null;
  iot_imei_no: string | null;
  status: string;
}

export default function EditInventoryItemPage() {
  const { itemId } = useParams() as { itemId: string };
  const router = useRouter();
  const [item, setItem] = useState<Item | null>(null);
  const [warehouse, setWarehouse] = useState("");
  const [imei, setImei] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/admin/inventory/${itemId}`);
        const json = await res.json();
        if (json.success) {
          setItem(json.data.item);
          setWarehouse(json.data.item.warehouse_location || "");
          setImei(json.data.item.iot_imei_no || "");
        } else {
          setError(json.error?.message || "Failed to load");
        }
      } catch (e) {
        setError("Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, [itemId]);

  const handleSave = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/inventory/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          warehouse_location: warehouse || null,
          iot_imei_no: imei || null,
        }),
      });
      const json = await res.json();
      if (json.success) {
        router.push(`/admin/inventory/${itemId}`);
      } else {
        setError(json.error?.message || "Save failed");
      }
    } catch (e) {
      setError("Request failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return <div className="p-8">Loading…</div>;
  if (!item) return <div className="p-8 text-red-600">{error || "Not found"}</div>;

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Edit inventory item</h1>
        <Link
          href={`/admin/inventory/${itemId}`}
          className="text-sm text-blue-600 hover:underline"
        >
          ← Back
        </Link>
      </header>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">
          {error}
        </div>
      )}

      <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-900">
          <strong>Locked fields:</strong> serial number, category, and invoice
          date cannot be edited. To correct these, write off the item and
          re-upload.
        </div>

        <div className="grid grid-cols-2 gap-4 text-sm">
          <Locked label="Serial" value={item.serial_number || "—"} />
          <Locked label="HSN" value={item.hsn_code || "—"} />
          <Locked label="Category" value={item.asset_category} />
          <Locked label="Model" value={item.model_type} />
        </div>

        <div className="grid grid-cols-2 gap-4 pt-2 border-t">
          <div>
            <label className="block text-xs font-bold uppercase text-gray-500 mb-1">
              Warehouse location
            </label>
            <input
              value={warehouse}
              onChange={(e) => setWarehouse(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-bold uppercase text-gray-500 mb-1">
              IoT IMEI
            </label>
            <input
              value={imei}
              onChange={(e) => setImei(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4">
          <Link
            href={`/admin/inventory/${itemId}`}
            className="px-4 py-2 bg-gray-200 rounded text-sm"
          >
            Cancel
          </Link>
          <button
            disabled={submitting}
            onClick={handleSave}
            className="px-5 py-2 bg-blue-600 text-white rounded font-bold hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Save"}
          </button>
        </div>
      </section>
    </div>
  );
}

function Locked({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-gray-500">{label}</div>
      <input
        value={value}
        readOnly
        disabled
        className="w-full border border-gray-200 bg-gray-50 rounded px-2 py-1.5 text-sm text-gray-500 cursor-not-allowed"
      />
    </div>
  );
}
