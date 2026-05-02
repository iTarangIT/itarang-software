"use client";

// 4-step bulk-upload wizard per BRD: Dealer → Asset Type → Template/File → Preview/Commit.
// Step 4 calls /validate first (no DB write); user inspects errors, then commits via /bulk-upload.

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type AssetType = "battery" | "charger" | "paraphernalia";

interface DealerOption {
  id: string;
  business_entity_name: string;
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

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  battery: "Battery (serialized)",
  charger: "Charger (serialized)",
  paraphernalia: "Paraphernalia (count-based)",
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
    } catch (e) {
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
        router.push(`/admin/inventory/upload-report/${json.data.reportId}`);
      } else {
        setError(json.error?.message || "Commit failed");
      }
    } catch (e) {
      setError("Commit request failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Bulk inventory upload</h1>
          <p className="text-sm text-gray-500">
            Step {step} of 4 — preview validates before committing.
          </p>
        </div>
        <Link
          href="/admin/inventory"
          className="text-sm text-blue-600 hover:underline"
        >
          ← Back to inventory
        </Link>
      </header>

      <Stepper step={step} />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded p-3 text-sm">
          {error}
        </div>
      )}

      {step === 1 && (
        <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
          <h2 className="font-bold">1. Select dealer</h2>
          <select
            value={dealerId}
            onChange={(e) => setDealerId(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          >
            <option value="">— Choose dealer —</option>
            {dealers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.business_entity_name} ({d.id})
              </option>
            ))}
          </select>
          <div className="flex justify-end">
            <button
              disabled={!dealerId}
              onClick={() => setStep(2)}
              className="px-5 py-2 bg-blue-600 text-white rounded font-bold hover:bg-blue-700 disabled:opacity-50"
            >
              Continue
            </button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
          <h2 className="font-bold">2. Select asset type</h2>
          <div className="grid grid-cols-3 gap-3">
            {(Object.keys(ASSET_TYPE_LABELS) as AssetType[]).map((t) => (
              <button
                key={t}
                onClick={() => setAssetType(t)}
                className={`border rounded p-4 text-left ${
                  assetType === t
                    ? "border-blue-600 bg-blue-50"
                    : "border-gray-300 hover:border-gray-400"
                }`}
              >
                <div className="font-bold text-sm">{ASSET_TYPE_LABELS[t]}</div>
              </button>
            ))}
          </div>
          <div className="flex justify-between pt-2">
            <button onClick={() => setStep(1)} className="px-4 py-2 bg-gray-200 rounded">
              Back
            </button>
            <button
              disabled={!assetType}
              onClick={() => setStep(3)}
              className="px-5 py-2 bg-blue-600 text-white rounded font-bold hover:bg-blue-700 disabled:opacity-50"
            >
              Continue
            </button>
          </div>
        </section>
      )}

      {step === 3 && assetType && (
        <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
          <h2 className="font-bold">3. Download template & upload</h2>
          <a
            href={`/api/admin/inventory/csv-template?type=${assetType}`}
            className="inline-flex items-center gap-2 text-sm text-blue-600 hover:underline"
          >
            ↓ Download {assetType} CSV template
          </a>
          <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="hidden"
            />
            {file ? (
              <div>
                <div className="font-medium">{file.name}</div>
                <div className="text-xs text-gray-500">
                  {(file.size / 1024).toFixed(1)} KB
                </div>
                <button
                  onClick={() => setFile(null)}
                  className="mt-2 text-sm text-red-600 hover:underline"
                >
                  Remove
                </button>
              </div>
            ) : (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="text-sm text-blue-600 hover:underline"
              >
                Choose CSV or XLSX file
              </button>
            )}
          </div>
          <div className="flex justify-between pt-2">
            <button onClick={() => setStep(2)} className="px-4 py-2 bg-gray-200 rounded">
              Back
            </button>
            <button
              disabled={!file || submitting}
              onClick={handleValidate}
              className="px-5 py-2 bg-blue-600 text-white rounded font-bold hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? "Validating…" : "Validate file"}
            </button>
          </div>
        </section>
      )}

      {step === 4 && validation && (
        <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
          <h2 className="font-bold">4. Preview & commit</h2>
          <div className="grid grid-cols-3 gap-3">
            <SummaryCard label="Total rows" value={validation.summary.total} />
            <SummaryCard
              label="Valid"
              value={validation.summary.valid}
              tone="green"
            />
            <SummaryCard
              label="Errors"
              value={validation.summary.errors}
              tone="red"
            />
          </div>

          <div className="overflow-x-auto max-h-[480px] overflow-y-auto border border-gray-200 rounded">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 sticky top-0">
                <tr className="text-left">
                  <th className="px-3 py-2">Row</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Serial / Item</th>
                  <th className="px-3 py-2">HSN / OEM</th>
                  <th className="px-3 py-2">Errors</th>
                </tr>
              </thead>
              <tbody>
                {validation.rows.map((r) => {
                  const d = (r.data ?? {}) as Record<string, unknown>;
                  return (
                    <tr
                      key={r.rowIndex}
                      className={`border-t border-gray-100 ${
                        r.status === "error" ? "bg-red-50" : ""
                      }`}
                    >
                      <td className="px-3 py-2 font-mono">{r.rowIndex}</td>
                      <td className="px-3 py-2">
                        {r.status === "valid" ? (
                          <span className="text-emerald-700 font-bold">✓</span>
                        ) : (
                          <span className="text-red-700 font-bold">✗</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {String(d.serial_number || d.model_type || "—")}
                      </td>
                      <td className="px-3 py-2">
                        {String(d.hsn_code || "—")} / {String(d.oem_name || "—")}
                      </td>
                      <td className="px-3 py-2 text-red-700">
                        {r.errors.length > 0 ? r.errors.join("; ") : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex justify-between pt-2">
            <button
              onClick={() => {
                setStep(3);
                setValidation(null);
              }}
              className="px-4 py-2 bg-gray-200 rounded"
            >
              Back / re-upload
            </button>
            <button
              disabled={validation.summary.valid === 0 || submitting}
              onClick={handleCommit}
              className="px-5 py-2 bg-emerald-600 text-white rounded font-bold hover:bg-emerald-700 disabled:opacity-50"
            >
              {submitting
                ? "Committing…"
                : `Commit ${validation.summary.valid} valid rows`}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  const labels = ["Dealer", "Asset type", "Template & file", "Preview & commit"];
  return (
    <ol className="flex items-center gap-2 text-xs">
      {labels.map((l, i) => {
        const idx = i + 1;
        const active = step === idx;
        const done = step > idx;
        return (
          <li key={l} className="flex items-center gap-2">
            <span
              className={`inline-flex w-6 h-6 items-center justify-center rounded-full font-bold text-xs ${
                done
                  ? "bg-emerald-600 text-white"
                  : active
                    ? "bg-blue-600 text-white"
                    : "bg-gray-200 text-gray-600"
              }`}
            >
              {idx}
            </span>
            <span
              className={`uppercase tracking-wide ${
                active ? "text-blue-600 font-bold" : "text-gray-500"
              }`}
            >
              {l}
            </span>
            {idx < labels.length && <span className="text-gray-300">›</span>}
          </li>
        );
      })}
    </ol>
  );
}

function SummaryCard({
  label,
  value,
  tone = "gray",
}: {
  label: string;
  value: number;
  tone?: "gray" | "green" | "red";
}) {
  const map = {
    gray: "bg-white border-gray-200",
    green: "bg-emerald-50 border-emerald-200 text-emerald-800",
    red: "bg-red-50 border-red-200 text-red-800",
  };
  return (
    <div className={`border rounded p-3 ${map[tone]}`}>
      <div className="text-xs uppercase tracking-wider text-gray-500">{label}</div>
      <div className="text-2xl font-bold mt-1">{value}</div>
    </div>
  );
}
