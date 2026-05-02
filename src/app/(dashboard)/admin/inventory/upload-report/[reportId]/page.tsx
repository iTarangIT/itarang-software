"use client";

// Audit view of a past bulk-upload batch.

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";

interface UploadReport {
  id: string;
  dealer_id: string;
  dealer_name: string | null;
  asset_type: string;
  uploaded_by: string;
  uploaded_by_name: string | null;
  uploaded_at: string;
  total_rows: number;
  inserted_rows: number;
  skipped_rows: number;
  errors_json: { row: number; error: string }[] | null;
  inserted_inventory_ids: string[] | null;
  source: string;
}

export default function UploadReportPage() {
  const { reportId } = useParams() as { reportId: string };
  const [report, setReport] = useState<UploadReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(
          `/api/admin/inventory/upload-report/${reportId}`,
        );
        const json = await res.json();
        if (json.success) setReport(json.data);
        else setError(json.error?.message || "Failed to load");
      } catch (e) {
        setError("Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, [reportId]);

  if (loading) return <div className="p-8">Loading…</div>;
  if (!report)
    return <div className="p-8 text-red-600">{error || "Not found"}</div>;

  const errors = report.errors_json ?? [];
  const insertedIds = report.inserted_inventory_ids ?? [];

  return (
    <div className="p-8 max-w-4xl mx-auto space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Upload report</h1>
          <p className="text-sm text-gray-500 font-mono">{report.id}</p>
        </div>
        <Link
          href="/admin/inventory"
          className="text-sm text-blue-600 hover:underline"
        >
          ← Back to inventory
        </Link>
      </header>

      <section className="bg-white border border-gray-200 rounded-lg p-6 space-y-4">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <Field label="Dealer" value={report.dealer_name || report.dealer_id} />
          <Field label="Asset type" value={report.asset_type} />
          <Field label="Source" value={report.source} />
          <Field label="Uploaded by" value={report.uploaded_by_name || report.uploaded_by} />
          <Field label="Uploaded at" value={new Date(report.uploaded_at).toLocaleString()} />
          <Field label="Total rows" value={String(report.total_rows)} />
          <Field
            label="Inserted"
            value={String(report.inserted_rows)}
            tone="green"
          />
          <Field
            label="Skipped"
            value={String(report.skipped_rows)}
            tone={report.skipped_rows > 0 ? "red" : "gray"}
          />
        </div>
      </section>

      {errors.length > 0 && (
        <section className="bg-white border border-red-200 rounded-lg p-6 space-y-3">
          <h2 className="font-bold text-red-700">Skipped rows ({errors.length})</h2>
          <table className="w-full text-xs">
            <thead className="bg-red-50">
              <tr className="text-left">
                <th className="px-3 py-2">Row</th>
                <th className="px-3 py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((e, idx) => (
                <tr key={idx} className="border-t border-red-100">
                  <td className="px-3 py-2 font-mono">{e.row}</td>
                  <td className="px-3 py-2 text-red-700">{e.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {insertedIds.length > 0 && (
        <section className="bg-white border border-emerald-200 rounded-lg p-6 space-y-3">
          <h2 className="font-bold text-emerald-700">
            Inserted items ({insertedIds.length})
          </h2>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {insertedIds.map((id) => (
              <Link
                key={id}
                href={`/admin/inventory/${id}`}
                className="font-mono text-blue-600 hover:underline"
              >
                {id}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  tone = "gray",
}: {
  label: string;
  value: string;
  tone?: "gray" | "green" | "red";
}) {
  const map = {
    gray: "text-gray-900",
    green: "text-emerald-700",
    red: "text-red-700",
  };
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`font-medium ${map[tone]}`}>{value}</div>
    </div>
  );
}
