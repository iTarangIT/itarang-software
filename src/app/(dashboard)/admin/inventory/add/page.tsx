"use client";

// Method B per BRD: admin adds a single inventory item via form.
// Model ID is the handshake into Product Master — selecting one auto-fills
// voltage, capacity, sub_category, warranty (customer), and chemistry, and
// drives the IoT / IMEI gating.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  ArrowRight,
  Plus,
  X as XIcon,
  Package,
} from "lucide-react";
import { PHYSICAL_CONDITIONS } from "@/lib/inventory/validation";

type AssetType = "battery" | "charger" | "paraphernalia";

interface DealerOption {
  id: string;
  business_entity_name: string;
}

interface BatteryMasterRow {
  model_id: string;
  model_name: string;
  compatible_categories: string[];
  compatible_sub_categories: string[];
  voltage_v: string | null;
  capacity_ah: string | null;
  battery_chemistry: string | null;
  warranty_months: number;
  iot_compatible: boolean;
  status: string;
}

interface ChargerMasterRow {
  model_id: string;
  model_name: string;
  output_voltage_v: string | null;
  output_current_a: string | null;
  charging_type: string | null;
  compatible_battery_models: string[];
  warranty_months: number;
  status: string;
}

interface ParaphernaliaMasterRow {
  item_type_code: string;
  display_label: string;
  compatible_categories: string[];
  status: string;
}

const FIELD_LABEL = "block text-xs font-bold uppercase text-gray-500 mb-1";
const INPUT = "w-full border border-gray-300 rounded px-2 py-1.5 text-sm";
const INPUT_DISABLED =
  "w-full border border-gray-300 rounded px-2 py-1.5 text-sm bg-gray-100 opacity-60 cursor-not-allowed";

export default function AddInventoryItemPage() {
  const router = useRouter();
  const [dealers, setDealers] = useState<DealerOption[]>([]);
  const [dealerId, setDealerId] = useState("");
  const [assetType, setAssetType] = useState<AssetType>("battery");

  const [batteryModels, setBatteryModels] = useState<BatteryMasterRow[]>([]);
  const [chargerModels, setChargerModels] = useState<ChargerMasterRow[]>([]);
  const [paraItems, setParaItems] = useState<ParaphernaliaMasterRow[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const [selectedKey, setSelectedKey] = useState("");
  const [form, setForm] = useState<Record<string, string>>({});
  const [iotEnabled, setIotEnabled] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successData, setSuccessData] = useState<{
    inventoryId: string;
    serial: string;
    dealerName: string;
    assetType: AssetType;
    modelLabel: string;
  } | null>(null);

  // Inline error for live duplicate-serial check on blur.
  const [serialError, setSerialError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/admin/dealers?limit=500");
        const json = await res.json();
        if (json.success) setDealers(json.data || []);
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  // Fetch the active product-master rows for the chosen asset type.
  useEffect(() => {
    let cancelled = false;
    setModelsLoading(true);
    setSelectedKey("");
    setForm({});
    setIotEnabled(false);

    const url =
      assetType === "battery"
        ? "/api/admin/product-master/batteries?status=active&limit=500"
        : assetType === "charger"
          ? "/api/admin/product-master/chargers?status=active&limit=500"
          : "/api/admin/product-master/paraphernalia?status=active&limit=500";

    (async () => {
      try {
        const res = await fetch(url);
        const json = await res.json();
        if (cancelled) return;
        const items = (json.data?.items ?? json.items ?? json.data ?? []) as unknown[];
        if (assetType === "battery") {
          setBatteryModels(
            (items as BatteryMasterRow[]).filter((m) => m.status === "active"),
          );
        } else if (assetType === "charger") {
          setChargerModels(
            (items as ChargerMasterRow[]).filter((m) => m.status === "active"),
          );
        } else {
          setParaItems(
            (items as ParaphernaliaMasterRow[]).filter((m) => m.status === "active"),
          );
        }
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [assetType]);

  const selectedBattery = useMemo(
    () =>
      assetType === "battery"
        ? batteryModels.find((m) => m.model_id === selectedKey) ?? null
        : null,
    [assetType, batteryModels, selectedKey],
  );
  const selectedCharger = useMemo(
    () =>
      assetType === "charger"
        ? chargerModels.find((m) => m.model_id === selectedKey) ?? null
        : null,
    [assetType, chargerModels, selectedKey],
  );
  const selectedPara = useMemo(
    () =>
      assetType === "paraphernalia"
        ? paraItems.find((m) => m.item_type_code === selectedKey) ?? null
        : null,
    [assetType, paraItems, selectedKey],
  );

  const compatibleCategories: string[] = useMemo(() => {
    if (selectedBattery) return selectedBattery.compatible_categories;
    if (selectedPara) return selectedPara.compatible_categories;
    if (selectedCharger) return ["3W", "2W", "4W", "Inverter", "Solar", "Other"];
    return [];
  }, [selectedBattery, selectedCharger, selectedPara]);

  // Resolve the category implied by a model_id by matching its trailing
  // segment (after the last `-`) against the model's compatible categories.
  // Lets `BAT-51V-176AH-3W` lock to "3W" even when compatible is ["3W","2W"].
  const resolveCategoryFromModelId = (
    modelId: string,
    compatible: string[],
  ): string => {
    const trimmed = (modelId || "").trim();
    if (!trimmed || compatible.length === 0) return "";
    const dashIdx = trimmed.lastIndexOf("-");
    const suffix = (dashIdx >= 0 ? trimmed.slice(dashIdx + 1) : trimmed).toLowerCase();
    if (!suffix) return "";
    const match = compatible.find((c) => c.toLowerCase() === suffix);
    if (match) return match;
    if (compatible.length === 1) return compatible[0];
    return "";
  };

  // When the model changes, default the IoT toggle and category. For non-IoT
  // batteries, force the toggle off and clear IMEI.
  useEffect(() => {
    if (selectedBattery) {
      setIotEnabled(selectedBattery.iot_compatible);
      const resolved = resolveCategoryFromModelId(
        selectedBattery.model_id,
        selectedBattery.compatible_categories,
      );
      setForm((s) => ({
        ...s,
        category: resolved
          ? resolved
          : s.category && selectedBattery.compatible_categories.includes(s.category)
            ? s.category
            : "",
        imei_id: selectedBattery.iot_compatible ? s.imei_id || "" : "",
      }));
    } else if (selectedCharger) {
      setIotEnabled(false);
      // Charger compatibleCategories is the static fallback list. Parse the
      // model_id suffix (e.g. "CHR-53V-178-3W" → "3W") so the dropdown locks
      // to the right vehicle class without the admin clicking again.
      const chargerCategories = ["3W", "2W", "4W", "Inverter", "Solar", "Other"];
      const resolved = resolveCategoryFromModelId(
        selectedCharger.model_id,
        chargerCategories,
      );
      setForm((s) => ({
        ...s,
        category: resolved
          ? resolved
          : s.category && chargerCategories.includes(s.category)
            ? s.category
            : "",
      }));
    } else if (selectedPara) {
      setIotEnabled(false);
      const resolved = resolveCategoryFromModelId(
        selectedPara.item_type_code,
        selectedPara.compatible_categories,
      );
      setForm((s) => ({
        ...s,
        category: resolved
          ? resolved
          : s.category && selectedPara.compatible_categories.includes(s.category)
            ? s.category
            : "",
      }));
    }
  }, [selectedBattery, selectedCharger, selectedPara]);

  const setField = (name: string, value: string) =>
    setForm((s) => ({ ...s, [name]: value }));

  // Live duplicate check fired on blur of Battery ID / Serial Number. Server
  // also enforces this on submit (409), so this is just for instant feedback.
  const checkSerialDuplicate = async (raw: string) => {
    const serial = (raw || "").trim();
    if (!serial) {
      setSerialError(null);
      return;
    }
    try {
      const res = await fetch(
        `/api/admin/inventory/check-serial?serial=${encodeURIComponent(serial)}`,
      );
      const json = await res.json();
      if (json?.success && json.data?.exists) {
        setSerialError(
          `Serial number / Battery ID must be unique — '${serial}' already exists.`,
        );
      } else {
        setSerialError(null);
      }
    } catch (e) {
      console.error(e);
      setSerialError(null);
    }
  };

  const resetForAnother = () => {
    setSuccessData(null);
    setForm({});
    setSelectedKey("");
    setIotEnabled(false);
    setSerialError(null);
  };

  const handleSubmit = async () => {
    if (!dealerId) {
      setError("Select a dealer");
      return;
    }
    if (!selectedKey) {
      setError(
        assetType === "paraphernalia"
          ? "Select an Item Type Code from Product Master"
          : "Select a Model ID from Product Master",
      );
      return;
    }
    if (!form.category) {
      setError("Select a category");
      return;
    }
    if (serialError) {
      setError(serialError);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const data: Record<string, unknown> = { ...form };
      if (assetType === "paraphernalia") {
        data.item_type_code = selectedKey;
      } else {
        data.model_id = selectedKey;
      }
      if (assetType === "battery") {
        data.iot_enabled = iotEnabled ? "true" : "false";
        if (!iotEnabled) data.imei_id = "";
      }

      const res = await fetch("/api/admin/inventory/add-item", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealerId, assetType, data }),
      });
      const json = await res.json();
      if (json.success) {
        const dealerName =
          dealers.find((d) => d.id === dealerId)?.business_entity_name ?? "the dealer";
        const serial =
          assetType === "paraphernalia"
            ? selectedKey
            : (form.battery_id || form.serial_number || json.data.id);
        const modelLabel =
          selectedBattery?.model_name ||
          selectedCharger?.model_name ||
          selectedPara?.display_label ||
          selectedKey;
        setSuccessData({
          inventoryId: json.data.id,
          serial,
          dealerName,
          assetType,
          modelLabel,
        });
      } else {
        setError(json.error?.message || "Failed to add item");
      }
    } catch (e) {
      console.error(e);
      setError("Request failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
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
            <label className={FIELD_LABEL}>Dealer</label>
            <select
              value={dealerId}
              onChange={(e) => setDealerId(e.target.value)}
              className={INPUT}
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
            <label className={FIELD_LABEL}>Asset type</label>
            <select
              value={assetType}
              onChange={(e) => setAssetType(e.target.value as AssetType)}
              className={INPUT}
            >
              <option value="battery">Battery</option>
              <option value="charger">Charger</option>
              <option value="paraphernalia">Paraphernalia</option>
            </select>
          </div>
        </div>

        {/* Model picker */}
        <div className="pt-2 border-t">
          <label className={FIELD_LABEL}>
            {assetType === "paraphernalia"
              ? "Item Type Code (from Product Master)"
              : "Model ID (from Product Master)"}
          </label>
          <select
            value={selectedKey}
            onChange={(e) => setSelectedKey(e.target.value)}
            className={INPUT}
            disabled={modelsLoading}
          >
            <option value="">
              {modelsLoading
                ? "Loading…"
                : assetType === "battery"
                  ? batteryModels.length
                    ? "— Choose Model ID —"
                    : "No active battery models in Product Master"
                  : assetType === "charger"
                    ? chargerModels.length
                      ? "— Choose Model ID —"
                      : "No active charger models in Product Master"
                    : paraItems.length
                      ? "— Choose Item Type Code —"
                      : "No active paraphernalia items in Product Master"}
            </option>
            {assetType === "battery" &&
              batteryModels.map((m) => (
                <option key={m.model_id} value={m.model_id}>
                  {m.model_id} — {m.model_name}
                </option>
              ))}
            {assetType === "charger" &&
              chargerModels.map((m) => (
                <option key={m.model_id} value={m.model_id}>
                  {m.model_id} — {m.model_name}
                </option>
              ))}
            {assetType === "paraphernalia" &&
              paraItems.map((m) => (
                <option key={m.item_type_code} value={m.item_type_code}>
                  {m.item_type_code} — {m.display_label}
                </option>
              ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Only active Product Master entries are listed. Voltage, capacity, sub-category,
            warranty, and chemistry are auto-filled from the selected model.
          </p>
        </div>

        {/* Auto-filled summary block */}
        {selectedBattery && (
          <div className="bg-blue-50 border border-blue-200 rounded p-4 space-y-2">
            <h3 className="text-sm font-bold text-blue-800">From Product Master</h3>
            <div className="grid grid-cols-3 gap-3 text-sm text-gray-700">
              <div><span className="text-gray-500">Model name:</span> {selectedBattery.model_name}</div>
              <div><span className="text-gray-500">Voltage:</span> {selectedBattery.voltage_v ?? "—"}</div>
              <div><span className="text-gray-500">Capacity (AH):</span> {selectedBattery.capacity_ah ?? "—"}</div>
              <div><span className="text-gray-500">Chemistry:</span> {selectedBattery.battery_chemistry ?? "—"}</div>
              <div><span className="text-gray-500">Warranty (months):</span> {selectedBattery.warranty_months}</div>
              <div><span className="text-gray-500">Sub-categories:</span> {selectedBattery.compatible_sub_categories.join(", ") || "—"}</div>
              <div><span className="text-gray-500">IoT compatible:</span> {selectedBattery.iot_compatible ? "Yes" : "No"}</div>
              <div className="col-span-2"><span className="text-gray-500">Compatible categories:</span> {selectedBattery.compatible_categories.join(", ") || "—"}</div>
            </div>
          </div>
        )}
        {selectedCharger && (
          <div className="bg-blue-50 border border-blue-200 rounded p-4 space-y-2">
            <h3 className="text-sm font-bold text-blue-800">From Product Master</h3>
            <div className="grid grid-cols-3 gap-3 text-sm text-gray-700">
              <div><span className="text-gray-500">Model name:</span> {selectedCharger.model_name}</div>
              <div><span className="text-gray-500">Output voltage:</span> {selectedCharger.output_voltage_v ?? "—"}</div>
              <div><span className="text-gray-500">Output current:</span> {selectedCharger.output_current_a ?? "—"}</div>
              <div><span className="text-gray-500">Charging type:</span> {selectedCharger.charging_type ?? "—"}</div>
              <div><span className="text-gray-500">Warranty (months):</span> {selectedCharger.warranty_months}</div>
              <div className="col-span-3"><span className="text-gray-500">Compatible batteries:</span> {selectedCharger.compatible_battery_models.join(", ") || "—"}</div>
            </div>
          </div>
        )}
        {selectedPara && (
          <div className="bg-blue-50 border border-blue-200 rounded p-4 space-y-2">
            <h3 className="text-sm font-bold text-blue-800">From Product Master</h3>
            <div className="grid grid-cols-3 gap-3 text-sm text-gray-700">
              <div className="col-span-1"><span className="text-gray-500">Display label:</span> {selectedPara.display_label}</div>
              <div className="col-span-2"><span className="text-gray-500">Compatible categories:</span> {selectedPara.compatible_categories.join(", ") || "—"}</div>
            </div>
          </div>
        )}

        {/* Common: Category dropdown — restricted to compatible categories of the selected master */}
        {selectedKey && (
          <div className="grid grid-cols-2 gap-4 pt-2 border-t">
            <div>
              <label className={FIELD_LABEL}>Category</label>
              {compatibleCategories.length === 1 ? (
                <input
                  type="text"
                  value={compatibleCategories[0]}
                  disabled
                  className={INPUT_DISABLED}
                />
              ) : form.category && compatibleCategories.includes(form.category) ? (
                <input
                  type="text"
                  value={form.category}
                  disabled
                  className={INPUT_DISABLED}
                />
              ) : (
                <select
                  value={form.category || ""}
                  onChange={(e) => setField("category", e.target.value)}
                  className={INPUT}
                >
                  <option value="">— Choose —</option>
                  {compatibleCategories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <label className={FIELD_LABEL}>Physical condition</label>
              <select
                value={form.physical_condition || ""}
                onChange={(e) => setField("physical_condition", e.target.value)}
                className={INPUT}
              >
                <option value="">— Choose —</option>
                {PHYSICAL_CONDITIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* Battery-specific fields */}
        {selectedBattery && (
          <>
            <div className="grid grid-cols-2 gap-4 pt-2">
              <div>
                <label className={FIELD_LABEL}>Battery ID / Serial Number</label>
                <input
                  type="text"
                  value={form.battery_id || ""}
                  onChange={(e) => {
                    setField("battery_id", e.target.value);
                    if (serialError) setSerialError(null);
                  }}
                  onBlur={(e) => checkSerialDuplicate(e.target.value)}
                  className={INPUT}
                />
                {serialError && (
                  <p className="text-xs text-red-600 mt-1">{serialError}</p>
                )}
              </div>
              <TextField label="Material Code" name="material_code" form={form} setField={setField} />
              <TextField label="Star Rating (1–5)" name="star_rating" type="number" form={form} setField={setField} />
              <TextField label="Invoice Number" name="invoice_number" form={form} setField={setField} />
              <TextField label="Sold / Invoice Date" name="sold_date" type="date" form={form} setField={setField} />
              <TextField label="Invoice Value (₹, pre-GST)" name="invoice_value" type="number" form={form} setField={setField} />
              <TextField label="HSN Code (8 digits)" name="hsn_code" form={form} setField={setField} />
              <TextField label="GST %" name="gst_percent" type="number" form={form} setField={setField} />
              <TextField label="Supplier / OEM Name" name="supplier_name" form={form} setField={setField} />
              <TextField label="OEM Warranty Start Date" name="oem_warranty_date" type="date" form={form} setField={setField} />
              <TextField label="OEM Warranty Months" name="oem_warranty_months" type="number" form={form} setField={setField} />
              <TextField label="Batch Reference (optional)" name="batch_reference" form={form} setField={setField} />
              <TextField label="Warehouse Location" name="warehouse_location" form={form} setField={setField} />
              <TextField label="OEM Warranty Clauses (optional)" name="oem_warranty_clauses" form={form} setField={setField} />
            </div>

            {/* IoT block */}
            <div className="pt-2 border-t grid grid-cols-2 gap-4">
              <div>
                <label className={FIELD_LABEL}>IoT Enabled</label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={iotEnabled}
                    onChange={(e) => setIotEnabled(e.target.checked)}
                    disabled={!selectedBattery.iot_compatible}
                  />
                  <span className={selectedBattery.iot_compatible ? "" : "text-gray-400"}>
                    {selectedBattery.iot_compatible
                      ? "Enable IoT for this unit"
                      : "Model is not IoT-compatible"}
                  </span>
                </label>
              </div>
              <div>
                <label className={FIELD_LABEL}>
                  IMEI ID
                  {selectedBattery.iot_compatible && iotEnabled && (
                    <span className="text-red-600 ml-1">*</span>
                  )}
                </label>
                <input
                  type="text"
                  value={form.imei_id || ""}
                  onChange={(e) => setField("imei_id", e.target.value)}
                  disabled={!selectedBattery.iot_compatible || !iotEnabled}
                  placeholder={
                    !selectedBattery.iot_compatible
                      ? "Disabled — model is not IoT-compatible"
                      : !iotEnabled
                        ? "Enable IoT to enter IMEI"
                        : "15-digit IMEI"
                  }
                  className={
                    !selectedBattery.iot_compatible || !iotEnabled
                      ? INPUT_DISABLED
                      : INPUT
                  }
                />
              </div>
            </div>
          </>
        )}

        {/* Charger-specific fields */}
        {selectedCharger && (
          <div className="grid grid-cols-2 gap-4 pt-2">
            <div>
              <label className={FIELD_LABEL}>Serial Number</label>
              <input
                type="text"
                value={form.serial_number || ""}
                onChange={(e) => {
                  setField("serial_number", e.target.value);
                  if (serialError) setSerialError(null);
                }}
                onBlur={(e) => checkSerialDuplicate(e.target.value)}
                className={INPUT}
              />
              {serialError && (
                <p className="text-xs text-red-600 mt-1">{serialError}</p>
              )}
            </div>
            <TextField label="Invoice Number" name="invoice_number" form={form} setField={setField} />
            <TextField label="Invoice Date" name="invoice_date" type="date" form={form} setField={setField} />
            <TextField label="Invoice Value (₹, pre-GST)" name="invoice_value" type="number" form={form} setField={setField} />
            <TextField label="HSN Code (8 digits)" name="hsn_code" form={form} setField={setField} />
            <TextField label="GST %" name="gst_percent" type="number" form={form} setField={setField} />
            <TextField label="Supplier / OEM Name" name="supplier_name" form={form} setField={setField} />
            <TextField label="Warehouse Location" name="warehouse_location" form={form} setField={setField} />
          </div>
        )}

        {/* Paraphernalia-specific fields */}
        {selectedPara && (
          <div className="grid grid-cols-2 gap-4 pt-2">
            <TextField label="Quantity" name="quantity" type="number" form={form} setField={setField} />
            <TextField label="Unit Cost (₹)" name="unit_cost" type="number" form={form} setField={setField} />
            <TextField label="Invoice Number" name="invoice_number" form={form} setField={setField} />
            <TextField label="Invoice Date" name="invoice_date" type="date" form={form} setField={setField} />
            <TextField label="Supplier (optional)" name="supplier" form={form} setField={setField} />
            <TextField label="Warehouse Location (optional)" name="warehouse_location" form={form} setField={setField} />
          </div>
        )}

        <div className="flex justify-end pt-4">
          <button
            disabled={submitting || !selectedKey}
            onClick={handleSubmit}
            className="px-5 py-2 bg-blue-600 text-white rounded font-bold hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? "Saving…" : "Add to inventory"}
          </button>
        </div>
      </section>

      {successData && (
        <AddItemSuccessModal
          data={successData}
          onView={() =>
            router.push(
              `/admin/inventory/${successData.inventoryId}?just_added=1&dealer=${encodeURIComponent(successData.dealerName)}`,
            )
          }
          onAddAnother={resetForAnother}
          onClose={() => setSuccessData(null)}
        />
      )}
    </div>
  );
}

function AddItemSuccessModal({
  data,
  onView,
  onAddAnother,
  onClose,
}: {
  data: {
    inventoryId: string;
    serial: string;
    dealerName: string;
    assetType: AssetType;
    modelLabel: string;
  };
  onView: () => void;
  onAddAnother: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-3xl max-w-md w-full shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative px-6 py-7 text-white text-center bg-gradient-to-br from-emerald-500 via-green-500 to-emerald-600 overflow-hidden">
          <div className="absolute inset-0 opacity-20 pointer-events-none">
            <div className="absolute -top-8 -right-8 w-40 h-40 rounded-full bg-white" />
            <div className="absolute -bottom-12 -left-12 w-44 h-44 rounded-full bg-white" />
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute top-3 right-3 w-8 h-8 rounded-lg bg-white/20 hover:bg-white/30 flex items-center justify-center transition-colors"
          >
            <XIcon className="w-4 h-4" />
          </button>
          <div className="relative">
            <div className="w-16 h-16 mx-auto rounded-full bg-white/25 backdrop-blur flex items-center justify-center ring-4 ring-white/20">
              <CheckCircle2 className="w-9 h-9" />
            </div>
            <h2 className="mt-4 text-2xl font-black tracking-tight">
              Item added to inventory!
            </h2>
            <p className="mt-1 text-sm font-medium opacity-90">
              <span className="font-black">{data.modelLabel}</span> assigned to{" "}
              <span className="font-black">{data.dealerName}</span>
            </p>
          </div>
        </div>

        <div className="px-6 pt-5 space-y-2">
          <ModalKV label="Serial / ID" value={data.serial} mono />
          <ModalKV
            label="Inventory record"
            value={data.inventoryId}
            mono
          />
          <ModalKV
            label="Asset type"
            value={
              data.assetType.charAt(0).toUpperCase() + data.assetType.slice(1)
            }
          />
          <div className="flex items-center justify-between gap-2 px-3.5 py-2 rounded-xl bg-emerald-50 border border-emerald-100">
            <span className="text-[10px] uppercase tracking-wider font-bold text-emerald-700">
              Status
            </span>
            <span className="inline-flex items-center gap-1 text-xs font-black text-emerald-700">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Available
            </span>
          </div>
        </div>

        <div className="px-6 py-5 mt-5 bg-gray-50 border-t border-gray-100 flex flex-col sm:flex-row gap-2">
          <button
            onClick={onAddAnother}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 border border-gray-200 bg-white rounded-xl text-sm font-bold text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add another
          </button>
          <button
            onClick={onView}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 bg-gradient-to-r from-[#0047AB] to-blue-600 hover:from-[#003580] hover:to-blue-700 text-white rounded-xl text-sm font-bold transition-all shadow-md shadow-blue-500/20"
          >
            View item
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalKV({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3.5 py-2 rounded-xl border border-gray-100 bg-gradient-to-r from-gray-50/50 to-white">
      <span className="text-[10px] uppercase tracking-wider font-bold text-gray-500 flex items-center gap-1.5">
        <Package className="w-3 h-3" />
        {label}
      </span>
      <span
        className={`text-xs text-gray-900 truncate max-w-[55%] ${mono ? "font-mono" : "font-bold"}`}
      >
        {value}
      </span>
    </div>
  );
}

function TextField({
  label,
  name,
  type = "text",
  form,
  setField,
}: {
  label: string;
  name: string;
  type?: string;
  form: Record<string, string>;
  setField: (name: string, value: string) => void;
}) {
  return (
    <div>
      <label className={FIELD_LABEL}>{label}</label>
      <input
        type={type}
        value={form[name] || ""}
        onChange={(e) => setField(name, e.target.value)}
        className={INPUT}
      />
    </div>
  );
}
