// NeoDove → Reconcile (E-224).
//
// The integrity backstop, given a UI. A dropped webhook is UNRECOVERABLE by any
// query — NeoDove has no read API — so the only way to find out what was missed
// is to export their CSV and diff it against what we received. Until now that
// backstop existed only as an API route with no caller, which meant in practice
// it would never be run.
//
// Reconciliation never drives a status change (see the route header): a CSV row
// is a historical record replayed later, and replaying transitions from it would
// rewrite the funnel from stale data. It writes the touchpoint and nothing else.

"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, FileUp, Info, Loader2 } from "lucide-react";

type Result = {
    rows_read: number;
    already_present: number;
    backfilled: number;
    unresolved: number;
    invalid: number;
    failed: number;
    drift: number;
    unresolved_samples: string[];
};

type CampaignOption = { id: string; name: string };

export default function NeodoveReconcilePage() {
    const inputRef = useRef<HTMLInputElement>(null);
    const [file, setFile] = useState<File | null>(null);
    const [campaignId, setCampaignId] = useState("");
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<Result | null>(null);
    const [error, setError] = useState<string | null>(null);

    const { data: campaigns } = useQuery<CampaignOption[]>({
        queryKey: ["neodove-campaigns-options"],
        queryFn: async () => {
            const res = await fetch("/api/neodove/campaigns");
            const json = await res.json();
            if (!json.success) return [];
            return json.data;
        },
    });

    async function upload() {
        if (!file) return;
        setBusy(true);
        setError(null);
        setResult(null);
        try {
            const form = new FormData();
            form.append("file", file);
            if (campaignId) form.append("campaignId", campaignId);
            const res = await fetch("/api/neodove/reconcile", {
                method: "POST",
                body: form,
            });
            const json = await res.json();
            if (!json.success) {
                throw new Error(json.error?.message ?? "Reconciliation failed");
            }
            setResult(json.data);
        } catch (err) {
            setError(err instanceof Error ? err.message : "Reconciliation failed");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="max-w-3xl mx-auto py-8 px-6 min-h-screen bg-gray-50">
            <Link
                href="/leads/neodove-campaigns"
                className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
            >
                <ArrowLeft className="w-4 h-4" /> NeoDove
            </Link>

            <h1 className="mt-3 text-2xl font-bold text-gray-900 tracking-tight">
                Reconcile from CSV
            </h1>
            <p className="text-sm text-gray-500 mt-1">
                Recover call outcomes that never reached us.
            </p>

            <div className="mt-5 rounded-xl border border-blue-100 bg-blue-50/60 px-4 py-3 text-sm text-blue-900 flex gap-2">
                <Info className="w-4 h-4 mt-0.5 shrink-0" />
                <div>
                    <p>
                        NeoDove has no read API, so a webhook it fails to deliver is gone
                        — it cannot be re-fetched or polled for. Exporting their report
                        and uploading it here is the only way to find and backfill what
                        was missed.
                    </p>
                    <p className="mt-1.5">
                        In NeoDove: <strong>Reports → export CSV</strong>. Backfilled
                        rows are marked <code className="font-mono text-xs">
                            reconciliation
                        </code>{" "}
                        forever, so live-delivery drift stays measurable.
                    </p>
                </div>
            </div>

            <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
                <label className="block text-sm font-medium text-gray-700">
                    Campaign (optional)
                </label>
                <select
                    value={campaignId}
                    onChange={(e) => setCampaignId(e.target.value)}
                    className="mt-1.5 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-gray-900 focus:outline-none"
                >
                    <option value="">Not linked to a campaign</option>
                    {(campaigns ?? []).map((c) => (
                        <option key={c.id} value={c.id}>
                            {c.name}
                        </option>
                    ))}
                </select>
                <p className="mt-1 text-xs text-gray-500">
                    Only tags the ledger rows. Matching is by phone number, so leaving
                    this blank still works.
                </p>

                <label className="mt-4 block text-sm font-medium text-gray-700">
                    NeoDove CSV export
                </label>
                <div className="mt-1.5 flex items-center gap-3">
                    <input
                        ref={inputRef}
                        type="file"
                        accept=".csv,text/csv"
                        onChange={(e) => {
                            setFile(e.target.files?.[0] ?? null);
                            setResult(null);
                            setError(null);
                        }}
                        className="block w-full text-sm text-gray-600 file:mr-3 file:rounded-lg file:border-0 file:bg-gray-900 file:px-3.5 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-gray-800"
                    />
                </div>
                <p className="mt-1 text-xs text-gray-500">
                    Up to 20,000 rows per upload. Re-uploading the same file is safe —
                    rows already recorded are counted and skipped, never duplicated.
                </p>

                {error && (
                    <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">
                        {error}
                    </p>
                )}

                <button
                    onClick={upload}
                    disabled={!file || busy}
                    className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                >
                    {busy ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                        <FileUp className="w-4 h-4" />
                    )}
                    {busy ? "Reconciling…" : "Reconcile"}
                </button>
            </div>

            {result && (
                <div className="mt-6 rounded-xl border border-gray-200 bg-white p-5">
                    <h2 className="text-sm font-semibold text-gray-900">Result</h2>
                    <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-3">
                        <Cell label="Rows read" value={result.rows_read} />
                        <Cell
                            label="Backfilled"
                            value={result.backfilled}
                            tone={
                                result.backfilled > 0
                                    ? "text-amber-600"
                                    : "text-gray-900"
                            }
                        />
                        <Cell label="Already recorded" value={result.already_present} />
                        <Cell label="No matching lead" value={result.unresolved} />
                        <Cell label="Invalid rows" value={result.invalid} />
                        <Cell
                            label="Failed"
                            value={result.failed}
                            tone={result.failed > 0 ? "text-rose-600" : "text-gray-900"}
                        />
                    </div>

                    {/* The number that actually matters. */}
                    <p className="mt-4 text-sm text-gray-700">
                        {result.backfilled === 0 ? (
                            <>
                                <strong>No drift.</strong> Every outcome in this export
                                had already reached us live — the webhook is doing its
                                job.
                            </>
                        ) : (
                            <>
                                <strong>
                                    {result.backfilled} outcome
                                    {result.backfilled === 1 ? "" : "s"} were missing
                                </strong>{" "}
                                and have been backfilled. Live webhook delivery is
                                lossy — if this number stays non-zero, the webhook
                                configuration in NeoDove is worth re-checking rather
                                than relying on periodic CSV imports.
                            </>
                        )}
                    </p>

                    {result.unresolved > 0 && (
                        <p className="mt-2 text-xs text-gray-500">
                            {result.unresolved} row
                            {result.unresolved === 1 ? "" : "s"} had no matching lead in
                            our system — these are leads created directly in NeoDove
                            rather than pushed from here.
                            {result.unresolved_samples.length > 0 && (
                                <>
                                    {" "}
                                    Examples:{" "}
                                    <span className="font-mono">
                                        {result.unresolved_samples
                                            .slice(0, 5)
                                            .join(", ")}
                                    </span>
                                </>
                            )}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}

function Cell({
    label,
    value,
    tone = "text-gray-900",
}: {
    label: string;
    value: number;
    tone?: string;
}) {
    return (
        <div className="rounded-lg border border-gray-200 px-3 py-2.5">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">
                {label}
            </p>
            <p className={`mt-0.5 text-lg font-bold tabular-nums ${tone}`}>{value}</p>
        </div>
    );
}
