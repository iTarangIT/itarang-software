"use client";

// 4-step bulk-upload wizard per BRD: Dealer → Asset Type → Template/File → Preview/Commit.
// Step 4 calls /validate first (no DB write); user inspects errors, then commits via /bulk-upload.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  XCircle,
  Download,
  UploadCloud,
  FileText,
  AlertTriangle,
  Building2,
  PackageCheck,
  ListChecks,
  X as XIcon,
} from "lucide-react";

type AssetType = "battery" | "charger" | "paraphernalia";

interface DealerOption {
  id: string;
  business_entity_name: string;
  dealer_code?: string | null;
  city?: string | null;
  state?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  address_line1?: string | null;
  pincode?: string | null;
  created_at?: string | null;
  currentStock?: {
    batteries: number;
    chargers: number;
    paraphernalia: number;
    available: number;
  };
}

interface ValidatedRow {
  rowIndex: number;
  status: "valid" | "error";
  data: Record<string, unknown> | null;
  errors: string[];
}

interface ValidationResponse {
  assetType: AssetType;
  summary: { total: number; valid: number; errors: number };
  rows: ValidatedRow[];
}

// BRD §5.0.2.3 — Inventory type spec for Step 2 cards.
const ASSET_TYPE_META: Record<
  AssetType,
  { title: string; tagline: string; serialTracked: boolean; covers: string }
> = {
  battery: {
    title: "Battery",
    tagline: "Primary inventory item — every physical pack",
    serialTracked: true,
    covers: "All battery units across 3W / 2W / 4W / Inverter / Solar",
  },
  charger: {
    title: "Charger",
    tagline: "Linked to compatible battery models",
    serialTracked: true,
    covers: "All charger units (fast / standard / smart / solar-compatible)",
  },
  paraphernalia: {
    title: "Paraphernalia",
    tagline: "Count-tracked, not serial-tracked",
    serialTracked: false,
    covers: "Digital SOC, Volt SOC, Harness variants, accessories",
  },
};

export default function BulkUploadWizard() {
  const router = useRouter();
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  const [dealers, setDealers] = useState<DealerOption[]>([]);
  const [dealerId, setDealerId] = useState("");
  const [assetType, setAssetType] = useState<AssetType | "">("");
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [validation, setValidation] = useState<ValidationResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [successData, setSuccessData] = useState<{
    uploadEventId: string;
    imported: number;
    skipped: number;
    total: number;
    dealerName: string;
    assetType: AssetType;
  } | null>(null);

  const selectedDealer = useMemo(
    () => dealers.find((d) => d.id === dealerId) ?? null,
    [dealers, dealerId],
  );

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          "/api/admin/dealers?limit=500&includeStock=1",
        );
        const json = await res.json();
        if (json.success) setDealers(json.data || []);
        else
          setError(
            json.error?.message ||
              "Failed to load dealers. Confirm the admin/dealers endpoint is reachable.",
          );
    } catch {
      setError("Failed to load dealers (network error).");
    }
    })();
  }, []);

  const handleValidate = async () => {
    if (!file || !assetType || !dealerId) return;
    setSubmitting(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("assetType", assetType);
      const res = await fetch("/api/admin/inventory/validate", {
        method: "POST",
        body: fd,
      });
      const json = await res.json();
      if (json.success) {
        setValidation(json.data);
        setStep(4);
      } else {
        setError(json.error?.message || "Validation failed");
      }
    } catch {
      setError("Validation request failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCommit = async () => {
    if (!validation || !dealerId || !assetType) return;
    const validRows = validation.rows
      .filter((r) => r.status === "valid" && r.data)
      .map((r) => r.data as Record<string, unknown>);
    if (validRows.length === 0) {
      setError("No valid rows to commit");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/inventory/bulk-upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dealerId, assetType, rows: validRows }),
      });
      const json = await res.json();
      if (json.success) {
        const uploadEventId = json.data?.uploadEventId || json.uploadEventId;
        const dealerName =
          dealers.find((d) => d.id === dealerId)?.business_entity_name ||
          "the dealer";
        setSuccessData({
          uploadEventId,
          imported: validation.summary.valid,
          skipped: validation.summary.errors,
          total: validation.summary.total,
          dealerName,
          assetType: assetType as AssetType,
        });
      } else {
        setError(json.error?.message || "Commit failed");
      }
    } catch {
      setError("Commit request failed");
    } finally {
      setSubmitting(false);
    }
  };

  const resetWizard = () => {
    setSuccessData(null);
    setValidation(null);
    setFile(null);
    setAssetType("");
    setStep(1);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 via-white to-gray-50">
      <div className="px-4 sm:px-6 lg:px-8 py-6 sm:py-8 max-w-6xl mx-auto space-y-6">
        <header className="space-y-3">
          <Link
            href="/admin/inventory"
            className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-500 hover:text-[#0047AB] transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Inventory
          </Link>
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl sm:text-3xl font-black text-gray-900 tracking-tight">
                Bulk inventory upload
              </h1>
              <p className="text-sm text-gray-500 mt-1">
                Validate before commit. Per-row save-points keep partial uploads safe.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {selectedDealer && (
                <ContextChip
                  icon={<Building2 className="w-3 h-3" />}
                  label={selectedDealer.business_entity_name}
                  tone="blue"
                />
              )}
              {assetType && (
                <ContextChip
                  icon={<PackageCheck className="w-3 h-3" />}
                  label={
                    assetType.charAt(0).toUpperCase() + assetType.slice(1)
                  }
                  tone="emerald"
                />
              )}
            </div>
          </div>
        </header>

        <Stepper step={step} />

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-3.5 text-sm flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

      {step === 1 && (
        <DealerStep
          dealers={dealers}
          dealerId={dealerId}
          setDealerId={setDealerId}
          onContinue={() => setStep(2)}
        />
      )}

      {step === 2 && (
        <section className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm space-y-5">
          <div>
            <h2 className="font-black text-gray-900">2. Select inventory type</h2>
            <p className="text-xs text-gray-500 mt-1">
              Each type has its own field set and Excel template. Batteries and
              chargers are tracked by individual serial number. Paraphernalia
              is tracked by quantity per item type.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {(Object.keys(ASSET_TYPE_META) as AssetType[]).map((t) => {
              const meta = ASSET_TYPE_META[t];
              const active = assetType === t;
              return (
                <button
                  key={t}
                  onClick={() => setAssetType(t)}
                  className={`text-left rounded-2xl p-5 transition-all border-2 ${
                    active
                      ? "border-[#0047AB] bg-[#0047AB]/5 shadow-md"
                      : "border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm"
                  }`}
                >
                  <div className="flex items-start justify-between mb-3">
                    <div
                      className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                        active
                          ? "bg-[#0047AB] text-white"
                          : "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {t === "battery" && <BatteryIcon />}
                      {t === "charger" && <PlugIcon />}
                      {t === "paraphernalia" && <BoxIcon />}
                    </div>
                    <span
                      className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                        meta.serialTracked
                          ? "bg-blue-50 text-blue-700"
                          : "bg-amber-50 text-amber-700"
                      }`}
                    >
                      {meta.serialTracked ? "Serial-tracked" : "Quantity-tracked"}
                    </span>
                  </div>
                  <div className="font-black text-gray-900 text-base">
                    {meta.title}
                  </div>
                  <div className="text-[11px] text-gray-500 mt-0.5">
                    {meta.tagline}
                  </div>
                  <div className="text-xs text-gray-700 mt-3 leading-relaxed">
                    {meta.covers}
                  </div>
                  {active && (
                    <div className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-bold text-[#0047AB]">
                      <span>✓ Selected</span>
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <div className="flex items-center justify-between gap-3 pt-2">
            <button
              onClick={() => setStep(1)}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 border border-gray-200 rounded-xl text-sm font-bold text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <button
              disabled={!assetType}
              onClick={() => setStep(3)}
              className="inline-flex items-center gap-1.5 px-6 py-2.5 bg-gradient-to-r from-[#0047AB] to-blue-600 hover:from-[#003580] hover:to-blue-700 text-white rounded-xl text-sm font-bold transition-all shadow-md shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
            >
              Continue
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </section>
      )}

      {step === 3 && assetType && (
        <section className="bg-white border border-gray-100 rounded-2xl p-5 sm:p-6 shadow-sm space-y-5">
          <div>
            <h2 className="font-black text-gray-900">
              3. Template &amp; file
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              Download the {assetType} template, fill it row by row, then drop the
              file below. We accept .csv and .xlsx up to 5 MB.
            </p>
          </div>

          <div className="flex items-start gap-3 p-3.5 rounded-xl border border-amber-200 bg-amber-50">
            <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
            <div className="text-[11px] text-amber-900 leading-relaxed">
              <span className="font-bold">
                {assetType === "paraphernalia" ? "Item Type Code" : "Model ID"} drives
                everything else.
              </span>{" "}
              Each row must reference an active entry in Admin → Product Master.
              Voltage, capacity, sub-category, customer warranty, chemistry, and
              compatible categories are auto-filled from the master. For batteries,
              IoT Enabled / IMEI is only allowed when the model is marked
              IoT-compatible.
            </div>
          </div>

          {/* Template download — promoted to a featured row */}
          <a
            href={`/api/admin/inventory/csv-template?type=${assetType}`}
            className="group flex items-center gap-3 p-3.5 rounded-xl border border-blue-100 bg-gradient-to-r from-blue-50 to-white hover:border-[#0047AB] hover:shadow-sm transition-all"
          >
            <div className="w-9 h-9 rounded-lg bg-[#0047AB] text-white flex items-center justify-center flex-shrink-0">
              <Download className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-gray-900">
                Download {assetType} Excel template
              </div>
              <div className="text-[11px] text-gray-500">
                Excel template · Dates accepted in YYYY-MM-DD or DD-MM-YYYY — Excel locale formatting is fine
              </div>
            </div>
            <ArrowRight className="w-4 h-4 text-gray-400 group-hover:text-[#0047AB] group-hover:translate-x-0.5 transition-all" />
          </a>

          {/* Drop zone */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          {file ? (
            <div className="flex items-center gap-3 p-4 rounded-2xl border border-emerald-200 bg-gradient-to-r from-emerald-50 to-white">
              <div className="w-10 h-10 rounded-xl bg-emerald-500 text-white flex items-center justify-center flex-shrink-0">
                <FileText className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-gray-900 truncate">
                  {file.name}
                </div>
                <div className="text-[11px] text-gray-500 mt-0.5">
                  {formatBytes(file.size)} ·{" "}
                  <span className="text-emerald-700 font-bold">
                    Ready to validate
                  </span>
                </div>
              </div>
              <button
                onClick={() => {
                  setFile(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
                aria-label="Remove file"
                className="w-8 h-8 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 flex items-center justify-center transition-colors"
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f) setFile(f);
              }}
              className={`w-full rounded-2xl border-2 border-dashed p-8 sm:p-10 text-center transition-all ${
                dragOver
                  ? "border-[#0047AB] bg-blue-50"
                  : "border-gray-200 bg-gray-50 hover:border-[#0047AB] hover:bg-blue-50/40"
              }`}
            >
              <div
                className={`w-12 h-12 rounded-2xl mx-auto flex items-center justify-center transition-colors ${
                  dragOver
                    ? "bg-[#0047AB] text-white"
                    : "bg-white border border-gray-200 text-[#0047AB]"
                }`}
              >
                <UploadCloud className="w-6 h-6" />
              </div>
              <div className="mt-3 text-sm font-bold text-gray-900">
                {dragOver ? "Drop to upload" : "Drag & drop your file here"}
              </div>
              <div className="text-[11px] text-gray-500 mt-1">
                or <span className="text-[#0047AB] font-bold">browse</span> from
                your computer · CSV / XLSX
              </div>
            </button>
          )}

          <div className="flex items-center justify-between gap-3 pt-2">
            <button
              onClick={() => setStep(2)}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 border border-gray-200 rounded-xl text-sm font-bold text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <button
              disabled={!file || submitting}
              onClick={handleValidate}
              className="inline-flex items-center gap-1.5 px-6 py-2.5 bg-gradient-to-r from-[#0047AB] to-blue-600 hover:from-[#003580] hover:to-blue-700 text-white rounded-xl text-sm font-bold transition-all shadow-md shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
            >
              {submitting ? "Validating…" : "Validate file"}
              {!submitting && <ArrowRight className="w-4 h-4" />}
            </button>
          </div>
        </section>
      )}

      {step === 4 && validation && (
        <section className="bg-white border border-gray-100 rounded-2xl p-5 sm:p-6 shadow-sm space-y-5">
          <div>
            <h2 className="font-black text-gray-900">4. Preview &amp; commit</h2>
            <p className="text-xs text-gray-500 mt-1">
              Only valid rows are committed. Errored rows stay reported below — fix
              the source CSV and re-upload to retry them.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <SummaryCard
              label="Total rows"
              value={validation.summary.total}
              icon={<ListChecks className="w-3.5 h-3.5" />}
            />
            <SummaryCard
              label="Valid"
              value={validation.summary.valid}
              total={validation.summary.total}
              tone="green"
              icon={<CheckCircle2 className="w-3.5 h-3.5" />}
            />
            <SummaryCard
              label="Errors"
              value={validation.summary.errors}
              total={validation.summary.total}
              tone="red"
              icon={<XCircle className="w-3.5 h-3.5" />}
            />
          </div>

          <div className="overflow-x-auto overflow-y-auto max-h-[480px] border border-gray-100 rounded-2xl">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr className="text-left">
                  <th className="px-3 py-2.5 font-black text-[10px] uppercase tracking-wider text-gray-500">
                    Row
                  </th>
                  <th className="px-3 py-2.5 font-black text-[10px] uppercase tracking-wider text-gray-500">
                    Status
                  </th>
                  <th className="px-3 py-2.5 font-black text-[10px] uppercase tracking-wider text-gray-500">
                    Serial / Item
                  </th>
                  <th className="px-3 py-2.5 font-black text-[10px] uppercase tracking-wider text-gray-500">
                    HSN / OEM
                  </th>
                  <th className="px-3 py-2.5 font-black text-[10px] uppercase tracking-wider text-gray-500">
                    Errors
                  </th>
                </tr>
              </thead>
              <tbody>
                {validation.rows.map((r) => {
                  const d = (r.data ?? {}) as Record<string, unknown>;
                  const isError = r.status === "error";
                  return (
                    <tr
                      key={r.rowIndex}
                      className={`border-t border-gray-50 transition-colors ${
                        isError
                          ? "bg-red-50/60 hover:bg-red-50"
                          : "hover:bg-blue-50/30"
                      }`}
                    >
                      <td className="px-3 py-2.5 font-mono text-gray-500">
                        {r.rowIndex}
                      </td>
                      <td className="px-3 py-2.5">
                        {isError ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100 text-red-700 text-[10px] font-bold">
                            <XCircle className="w-3 h-3" /> Error
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold">
                            <CheckCircle2 className="w-3 h-3" /> Valid
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-gray-900">
                        {String(
                          d.battery_id ||
                            d.serial_number ||
                            d.item_type ||
                            d.model_number ||
                            "—",
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-gray-700">
                        {String(d.material_code || "—")}{" "}
                        <span className="text-gray-300">/</span>{" "}
                        {String(d.supplier_name || d.supplier || "—")}
                      </td>
                      <td className="px-3 py-2.5">
                        {r.errors.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {r.errors.map((err, i) => (
                              <span
                                key={i}
                                className="inline-flex items-center px-2 py-0.5 rounded-md bg-red-100 text-red-700 text-[10px] font-medium"
                              >
                                {err}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-3 pt-2">
            <button
              onClick={() => {
                setStep(3);
                setValidation(null);
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 border border-gray-200 rounded-xl text-sm font-bold text-gray-700 hover:bg-gray-50 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back / re-upload
            </button>
            <button
              disabled={validation.summary.valid === 0 || submitting}
              onClick={handleCommit}
              className="inline-flex items-center gap-1.5 px-6 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white rounded-xl text-sm font-bold transition-all shadow-md shadow-emerald-500/20 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
            >
              <CheckCircle2 className="w-4 h-4" />
              {submitting
                ? "Committing…"
                : `Commit ${validation.summary.valid} valid row${validation.summary.valid === 1 ? "" : "s"}`}
            </button>
          </div>
        </section>
      )}
      </div>

      {successData && (
        <UploadSuccessModal
          data={successData}
          onViewReport={() =>
            router.push(`/admin/inventory/upload-report/${successData.uploadEventId}`)
          }
          onUploadMore={resetWizard}
          onClose={() => setSuccessData(null)}
        />
      )}
    </div>
  );
}

function UploadSuccessModal({
  data,
  onViewReport,
  onUploadMore,
  onClose,
}: {
  data: {
    uploadEventId: string;
    imported: number;
    skipped: number;
    total: number;
    dealerName: string;
    assetType: AssetType;
  };
  onViewReport: () => void;
  onUploadMore: () => void;
  onClose: () => void;
}) {
  const hasErrors = data.skipped > 0;
  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-3xl max-w-md w-full shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Hero with gradient */}
        <div
          className={`relative px-6 py-7 text-white text-center overflow-hidden ${
            hasErrors
              ? "bg-gradient-to-br from-amber-500 via-orange-500 to-amber-600"
              : "bg-gradient-to-br from-emerald-500 via-green-500 to-emerald-600"
          }`}
        >
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
              {hasErrors ? (
                <AlertTriangle className="w-9 h-9" />
              ) : (
                <CheckCircle2 className="w-9 h-9" />
              )}
            </div>
            <h2 className="mt-4 text-2xl font-black tracking-tight">
              {hasErrors ? "Upload partially complete" : "Upload successful!"}
            </h2>
            <p className="mt-1 text-sm font-medium opacity-90">
              {data.imported} {data.assetType}
              {data.imported === 1 ? "" : "s"} added to{" "}
              <span className="font-black">{data.dealerName}</span>
            </p>
          </div>
        </div>

        {/* Stats grid */}
        <div className="px-6 pt-5 grid grid-cols-3 gap-2">
          <ModalStat label="Total" value={data.total} tone="gray" />
          <ModalStat label="Imported" value={data.imported} tone="emerald" />
          <ModalStat
            label="Skipped"
            value={data.skipped}
            tone={hasErrors ? "red" : "gray"}
          />
        </div>

        {/* Meta row */}
        <div className="px-6 mt-4 space-y-1.5 text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-gray-500 uppercase tracking-wider font-bold">
              Report ID
            </span>
            <span className="font-mono text-gray-900 truncate">
              {data.uploadEventId}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-gray-500 uppercase tracking-wider font-bold">
              Type
            </span>
            <span className="font-bold text-gray-900 capitalize">
              {data.assetType}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="px-6 py-5 mt-4 bg-gray-50 border-t border-gray-100 flex flex-col sm:flex-row gap-2">
          <button
            onClick={onUploadMore}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 border border-gray-200 bg-white rounded-xl text-sm font-bold text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <UploadCloud className="w-4 h-4" />
            Upload more
          </button>
          <button
            onClick={onViewReport}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 bg-gradient-to-r from-[#0047AB] to-blue-600 hover:from-[#003580] hover:to-blue-700 text-white rounded-xl text-sm font-bold transition-all shadow-md shadow-blue-500/20"
          >
            View detailed report
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "gray" | "emerald" | "red";
}) {
  const map = {
    gray: "from-white to-gray-50 border-gray-200 text-gray-900",
    emerald: "from-emerald-50 to-white border-emerald-200 text-emerald-700",
    red: "from-red-50 to-white border-red-200 text-red-700",
  }[tone];
  return (
    <div
      className={`bg-gradient-to-br border rounded-xl px-2.5 py-2.5 text-center ${map}`}
    >
      <div className="text-2xl font-black leading-none">{value}</div>
      <div className="text-[9px] uppercase tracking-wider font-bold text-gray-500 mt-1">
        {label}
      </div>
    </div>
  );
}

function DealerStep({
  dealers,
  dealerId,
  setDealerId,
  onContinue,
}: {
  dealers: DealerOption[];
  dealerId: string;
  setDealerId: (id: string) => void;
  onContinue: () => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return dealers.slice(0, 50);
    return dealers
      .filter((d) =>
        [
          d.business_entity_name,
          d.dealer_code,
          d.city,
          d.state,
        ]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q)),
      )
      .slice(0, 50);
  }, [query, dealers]);

  const selected = dealers.find((d) => d.id === dealerId) ?? null;

  const initials = (s: string | null | undefined) =>
    (s || "?")
      .split(/\s+/)
      .map((w) => w.charAt(0).toUpperCase())
      .slice(0, 2)
      .join("") || "?";

  return (
    <section className="bg-white border border-gray-100 rounded-2xl p-6 shadow-sm space-y-5">
      <div>
        <h2 className="font-black text-gray-900">1. Select dealer</h2>
        <p className="text-xs text-gray-500 mt-1">
          Search by dealer name, code, or city. All inventory uploaded in this
          session is assigned to the selected dealer.
        </p>
      </div>

      {/* Search input */}
      <div className="relative">
        <input
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          placeholder={
            dealers.length === 0
              ? "No dealers loaded — see error above"
              : "Type a dealer name, code, or city…"
          }
          disabled={dealers.length === 0}
          className="w-full border border-gray-200 rounded-xl px-4 py-2.5 text-sm focus:border-[#0047AB] focus:outline-none disabled:bg-gray-50"
        />
        {open && filtered.length > 0 && (
          <div className="absolute z-20 left-0 right-0 mt-1 max-h-72 overflow-auto bg-white border border-gray-200 rounded-xl shadow-lg">
            {filtered.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => {
                  setDealerId(d.id);
                  setQuery(d.business_entity_name);
                  setOpen(false);
                }}
                className={`w-full text-left px-4 py-2.5 hover:bg-blue-50 border-b border-gray-50 last:border-b-0 ${
                  d.id === dealerId ? "bg-blue-50/60" : ""
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-bold text-gray-900 text-sm">
                      {d.business_entity_name}
                    </div>
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      {[d.dealer_code, d.city, d.state]
                        .filter(Boolean)
                        .join(" · ") || "—"}
                    </div>
                  </div>
                  {d.currentStock && (
                    <span className="text-[10px] font-bold text-gray-500 whitespace-nowrap">
                      {d.currentStock.batteries}🔋 ·{" "}
                      {d.currentStock.chargers}🔌 ·{" "}
                      {d.currentStock.paraphernalia}📦
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Dealer Info Card (BRD §5.0.2.2) */}
      {selected && (
        <div className="bg-gradient-to-r from-[#0047AB]/5 to-blue-50 border border-[#0047AB]/20 rounded-2xl p-5">
          <div className="flex items-start gap-4">
            <div className="w-12 h-12 rounded-xl bg-[#0047AB] text-white flex items-center justify-center font-black text-sm flex-shrink-0">
              {initials(selected.business_entity_name)}
            </div>
            <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs">
              <KV label="Dealer Name" value={selected.business_entity_name} />
              <KV label="Dealer Code" value={selected.dealer_code ?? "—"} mono />
              <KV
                label="City / State"
                value={
                  [selected.city, selected.state].filter(Boolean).join(" / ") ||
                  "—"
                }
              />
              <KV
                label="Address"
                value={
                  [selected.address_line1, selected.pincode]
                    .filter(Boolean)
                    .join(", ") || "—"
                }
              />
              <KV
                label="Active Since"
                value={
                  selected.created_at
                    ? new Date(selected.created_at).toLocaleDateString("en-IN", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })
                    : "—"
                }
              />
              <KV
                label="Contact"
                value={
                  [selected.contact_name, selected.contact_phone]
                    .filter(Boolean)
                    .join(" · ") || "—"
                }
              />
            </div>
          </div>
          {selected.currentStock && (
            <div className="grid grid-cols-3 gap-3 mt-4 pt-4 border-t border-blue-100">
              <StockCount
                label="Batteries"
                value={selected.currentStock.batteries}
              />
              <StockCount
                label="Chargers"
                value={selected.currentStock.chargers}
              />
              <StockCount
                label="Paraphernalia"
                value={selected.currentStock.paraphernalia}
              />
            </div>
          )}
        </div>
      )}

      <div className="flex justify-end pt-2">
        <button
          disabled={!dealerId}
          onClick={onContinue}
          className="inline-flex items-center gap-1.5 px-6 py-2.5 bg-gradient-to-r from-[#0047AB] to-blue-600 hover:from-[#003580] hover:to-blue-700 text-white rounded-xl text-sm font-bold transition-all shadow-md shadow-blue-500/20 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
        >
          Continue
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </section>
  );
}

function KV({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-bold text-gray-400">
        {label}
      </div>
      <div
        className={`text-gray-900 mt-0.5 ${mono ? "font-mono" : "font-medium"}`}
      >
        {value}
      </div>
    </div>
  );
}

function BatteryIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <rect x="3" y="7" width="15" height="10" rx="2" strokeWidth="2" />
      <path d="M21 10v4" strokeWidth="2" strokeLinecap="round" />
      <path d="M7 10v4M11 10v4" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function PlugIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        d="M9 7V3m6 4V3M6 11h12v3a6 6 0 11-12 0v-3z"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M12 20v2" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
function BoxIcon() {
  return (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path d="M3.27 6.96L12 12.01l8.73-5.05M12 22.08V12" strokeWidth="2" />
    </svg>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function StockCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white border border-blue-100 rounded-xl px-3 py-2 text-center">
      <div className="text-lg font-black text-[#0047AB]">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">
        {label}
      </div>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  const labels = ["Dealer", "Asset type", "Template & file", "Preview & commit"];
  const totalSteps = labels.length;
  // Progress fill: 0% on step 1, 33% step 2, 66% step 3, 100% step 4.
  const progressPct = totalSteps > 1 ? ((step - 1) / (totalSteps - 1)) * 100 : 0;

  return (
    <div className="bg-white border border-gray-100 rounded-2xl p-4 sm:p-5 shadow-sm">
      {/* Mobile: compact inline step indicator. */}
      <div className="sm:hidden">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#0047AB]">
            Step {step} of {totalSteps}
          </span>
          <span className="text-[11px] font-bold text-gray-700">
            {labels[step - 1]}
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-[#0047AB] to-blue-400 transition-[width] duration-500 ease-out"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      {/* Tablet+ : full stepper with connecting bar and gradient fill. */}
      <ol className="hidden sm:flex items-center relative">
        {/* Background track */}
        <div
          className="absolute top-4 left-4 right-4 h-0.5 bg-gray-100 rounded-full"
          aria-hidden
        />
        {/* Filled progress */}
        <div
          className="absolute top-4 left-4 h-0.5 bg-gradient-to-r from-[#0047AB] to-blue-400 rounded-full transition-[width] duration-500 ease-out"
          style={{
            width: `calc((100% - 2rem) * ${progressPct / 100})`,
          }}
          aria-hidden
        />
        {labels.map((l, i) => {
          const idx = i + 1;
          const active = step === idx;
          const done = step > idx;
          return (
            <li
              key={l}
              className="relative flex-1 flex flex-col items-center gap-2 z-10"
            >
              <span
                className={`inline-flex w-8 h-8 items-center justify-center rounded-full font-black text-[11px] border-2 transition-all duration-300 ${
                  done
                    ? "bg-gradient-to-br from-emerald-500 to-emerald-600 border-emerald-600 text-white shadow-md shadow-emerald-500/30"
                    : active
                      ? "bg-gradient-to-br from-[#0047AB] to-blue-500 border-[#0047AB] text-white shadow-md shadow-blue-500/30 ring-4 ring-blue-100"
                      : "bg-white border-gray-200 text-gray-400"
                }`}
              >
                {done ? <CheckCircle2 className="w-4 h-4" /> : idx}
              </span>
              <span
                className={`text-[10px] uppercase tracking-wider font-bold text-center px-1 ${
                  active
                    ? "text-[#0047AB]"
                    : done
                      ? "text-emerald-700"
                      : "text-gray-400"
                }`}
              >
                {l}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function ContextChip({
  icon,
  label,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  tone: "blue" | "emerald";
}) {
  const styles = {
    blue: "bg-blue-50 border-blue-200 text-[#0047AB]",
    emerald: "bg-emerald-50 border-emerald-200 text-emerald-700",
  }[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-bold max-w-[200px] ${styles}`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </span>
  );
}

function SummaryCard({
  label,
  value,
  total,
  tone = "gray",
  icon,
}: {
  label: string;
  value: number;
  total?: number;
  tone?: "gray" | "green" | "red";
  icon?: React.ReactNode;
}) {
  const map = {
    gray: {
      wrap: "bg-gradient-to-br from-white to-gray-50 border-gray-200",
      number: "text-gray-900",
      iconBg: "bg-gray-100 text-gray-500",
      bar: "bg-gray-300",
    },
    green: {
      wrap: "bg-gradient-to-br from-emerald-50 to-white border-emerald-200",
      number: "text-emerald-700",
      iconBg: "bg-emerald-100 text-emerald-700",
      bar: "bg-emerald-500",
    },
    red: {
      wrap: "bg-gradient-to-br from-red-50 to-white border-red-200",
      number: "text-red-700",
      iconBg: "bg-red-100 text-red-700",
      bar: "bg-red-500",
    },
  }[tone];
  const pct =
    typeof total === "number" && total > 0
      ? Math.min(100, Math.round((value / total) * 100))
      : null;
  return (
    <div className={`border rounded-2xl p-4 ${map.wrap}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10px] uppercase tracking-wider font-bold text-gray-500">
          {label}
        </div>
        {icon && (
          <div
            className={`w-7 h-7 rounded-lg flex items-center justify-center ${map.iconBg}`}
          >
            {icon}
          </div>
        )}
      </div>
      <div className={`text-3xl font-black mt-2 ${map.number}`}>{value}</div>
      {pct !== null && (
        <div className="mt-3 space-y-1">
          <div className="h-1 rounded-full bg-gray-100 overflow-hidden">
            <div
              className={`h-full transition-[width] duration-500 ${map.bar}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="text-[10px] font-bold text-gray-500">
            {pct}% of total
          </div>
        </div>
      )}
    </div>
  );
}
