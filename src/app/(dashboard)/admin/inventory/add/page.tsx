"use client";

// Method B per BRD: admin adds a single inventory item via form.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type AssetType = "battery" | "charger" | "paraphernalia";

interface DealerOption {
  id: string;
  business_entity_name: string;
}

const BATTERY_FIELDS = [
  { name: "battery_id", label: "Battery ID / Serial Number", type: "text" },
  { name: "material_code", label: "Material Code", type: "text" },
  { name: "category", label: "Category", type: "text" },
  { name: "sub_category", label: "Sub Category", type: "text" },
  { name: "model_number", label: "Model Number", type: "text" },
  { name: "voltage_v", label: "Voltage", type: "number" },
  { name: "capacity_ah", label: "Capacity AH", type: "number" },
  { name: "star_rating", label: "Star Rating", type: "number" },
  { name: "invoice_number", label: "Invoice Number", type: "text" },
  { name: "sold_date", label: "Sold / Invoice Date", type: "date" },
  { name: "invoice_value", label: "Invoice Value", type: "number" },
  { name: "supplier_name", label: "Supplier / OEM Name", type: "text" },
  { name: "oem_warranty_date", label: "OEM Warranty Start Date", type: "date" },
  { name: "oem_warranty_months", label: "OEM Warranty Months", type: "number" },
  { name: "physical_condition", label: "Physical Condition", type: "text" },
  { name: "warehouse_location", label: "Warehouse Location", type: "text" },
  { name: "iot_enabled", label: "IoT Enabled true/false", type: "text" },
  { name: "imei_id", label: "IMEI ID optional", type: "text" },
  { name: "batch_reference", label: "Batch Reference optional", type: "text" },
];

const SERIALIZED_FIELDS = [
  { name: "serial_number", label: "Serial number", type: "text" },
  { name: "iot_imei_no", label: "IoT IMEI (optional)", type: "text" },
  { name: "batch_number", label: "Batch number (optional)", type: "text" },
];

const PARAPHERNALIA_FIELDS = [
  { name: "asset_type", label: "Asset type (e.g. Cable)", type: "text" },
  { name: "model_type", label: "Model type", type: "text" },
  { name: "quantity", label: "Quantity", type: "number" },
];

export default function AddInventoryItemPage() {
  const router = useRouter();
  const [dealers, setDealers] = useState<DealerOption[]>([]);
  const [dealerId, setDealerId] = useState("");
  const [assetType, setAssetType] = useState<AssetType>("battery");
  const [form, setForm] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/dealers?status=active&limit=500");
        const json = await res.json();
        if (json.success) setDealers(json.data || []);
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  const fields =
    assetType === "battery"
      ? BATTERY_FIELDS
      : assetType === "charger"
        ? CHARGER_FIELDS
        : PARAPHERNALIA_FIELDS;
  const handleSubmit = async () => {
    if (!dealerId) {
      setError("Select a dealer");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const data: Record<string, unknown> = { ...form };
      const res = await fetch("/api/admin/inventory/add-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealerId, assetType, data }),
      });
      const json = await res.json();
      if (json.success) {
        router.push(`/admin/inventory/${json.data.id}`);
      } else {
        setError(json.error?.message || "Failed to add item");
      }
    } catch (e) {
      setError("Request failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Add inventory item</h1>
        <Link
          href="/admin/inventory"
          className="text-sm text-blue-600 hover:underline"
        >
          ← Back to inventory
        </Link>
      </header>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">
          {error}
        </div>
      )}

      <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold uppercase text-gray-500 mb-1">
              Dealer
            </label>
            <select
              value={dealerId}
              onChange={(e) => setDealerId(e.target.value)}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
            >
              <option value="">— Choose —</option>
              {dealers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.business_entity_name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold uppercase text-gray-500 mb-1">
              Asset type
            </label>
            <select
              value={assetType}
              onChange={(e) => setAssetType(e.target.value as AssetType)}
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
            >
              <option value="battery">Battery</option>
              <option value="charger">Charger</option>
              <option value="paraphernalia">Paraphernalia</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 pt-2 border-t">
          {fields.map((f) => (
            <div key={f.name}>
              <label className="block text-xs font-bold uppercase text-gray-500 mb-1">
                {f.label}
              </label>
              <input
                type={f.type}
                value={form[f.name] || ""}
                onChange={(e) =>
                  setForm((s) => ({ ...s, [f.name]: e.target.value }))
                }
                className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
              />
            </div>
          ))}
        </div>

        <div className="flex justify-end pt-4">
          <button
            disabled={submitting}
            onClick={handleSubmit}
            className="px-5 py-2 bg-blue-600 text-white rounded font-bold hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Add to inventory"}
          </button>
        </div>
      </section>
    </div>
  );
}
