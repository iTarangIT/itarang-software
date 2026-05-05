"use client";

// 4-step bulk-upload wizard per BRD: Dealer → Asset Type → Template/File → Preview/Commit.
// Step 4 calls /validate first (no DB write); user inspects errors, then commits via /bulk-upload.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

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

const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  battery: "Battery (serialized)",
  charger: "Charger (serialized)",
  paraphernalia: "Paraphernalia (count-based)",
};

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

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          "/api/admin/dealers?status=active&limit=500&includeStock=1",
        );
        const json = await res.json();
        if (json.success) setDealers(json.data || []);
        else
          setError(
            json.error?.message ||
              "Failed to load dealers. Confirm the admin/dealers endpoint is reachable.",
          );
      } catch (e) {
        console.error(e);
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
              Each type has its own field set and CSV template. Batteries and
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

          <div className="flex justify-between pt-2">
            <button
              onClick={() => setStep(1)}
              className="px-4 py-2 border border-gray-200 rounded-xl text-sm font-bold hover:bg-gray-50"
            >
              ← Back
            </button>
            <button
              disabled={!assetType}
              onClick={() => setStep(3)}
              className="px-6 py-2.5 bg-[#0047AB] hover:bg-[#003580] text-white rounded-xl text-sm font-bold transition-colors disabled:opacity-50"
            >
              Continue →
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
          className="px-6 py-2.5 bg-[#0047AB] hover:bg-[#003580] text-white rounded-xl text-sm font-bold transition-colors disabled:opacity-50"
        >
          Continue →
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
