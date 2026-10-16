"use client";

// A33 — set Hot / Warm / Cold on many leads from one CSV: preview first
// (nothing written), then apply. Each change is audited like a manual one.

import { useState } from "react";
import { toast } from "sonner";
import { Flame, Loader2 } from "lucide-react";

type Row = { line: number; lead_id: string | null; dealer: string | null; from: string | null; to: string | null; result: string };
type Result = { applied: boolean; changed: number; same: number; refused: number; rows: Row[]; more: boolean };

export function InterestUploadCard() {
    const [csv, setCsv] = useState<string | null>(null);
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);
    const [res, setRes] = useState<Result | null>(null);

    async function run(apply: boolean) {
        if (!csv) return;
        setBusy(true);
        try {
            const r = await fetch("/api/admin/leads/interest-upload", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ csv, apply }),
            });
            const j = await r.json();
            if (!r.ok || !j.success) throw new Error(j?.error?.message ?? "Could not read the file");
            setRes(j.data as Result);
            if (apply) toast.success(`${j.data.changed} lead(s) updated.`);
        } catch (e) {
            toast.error((e as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="rounded-xl border border-border bg-surface p-5 shadow-card space-y-3">
            <div className="flex items-center gap-2">
                <Flame className="h-4 w-4 text-rose-500" />
                <h2 className="text-base font-semibold text-ink">Bulk interest level (Hot / Warm / Cold)</h2>
            </div>
            <p className="text-sm text-ink-muted">
                A CSV with a <code>lead_id</code> or <code>phone</code> column and an <code>interest</code> column (hot, warm or
                cold). Preview first — nothing changes until you apply. Every change is logged like a manual one.
            </p>
            <div className="flex flex-wrap items-center gap-2">
                <input
                    type="file"
                    accept=".csv,text/csv"
                    aria-label="Interest level CSV"
                    onChange={async (e) => {
                        const f = e.target.files?.[0];
                        setRes(null);
                        if (!f) return setCsv(null);
                        setName(f.name);
                        setCsv(await f.text());
                    }}
                    className="text-sm"
                />
                <button
                    type="button"
                    disabled={!csv || busy}
                    onClick={() => run(false)}
                    className="rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-ink disabled:opacity-50"
                >
                    {busy && !res?.applied ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : null} Preview
                </button>
                <button
                    type="button"
                    disabled={!csv || busy || !res || res.applied || res.changed === 0}
                    onClick={() => run(true)}
                    className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                    Apply {res && !res.applied ? res.changed : ""} change{res?.changed === 1 ? "" : "s"}
                </button>
            </div>
            {res && (
                <div className="space-y-2">
                    <p className="text-sm text-ink">
                        {name}: <strong>{res.changed}</strong> {res.applied ? "changed" : "will change"} · {res.same} already at that level ·{" "}
                        <span className={res.refused ? "text-danger" : ""}>{res.refused} refused</span>
                    </p>
                    <div className="max-h-72 overflow-auto rounded-lg border border-border">
                        <table className="w-full text-xs">
                            <thead className="sticky top-0 bg-bg text-left text-ink-muted">
                                <tr>
                                    <th className="px-2 py-1.5">Line</th>
                                    <th className="px-2 py-1.5">Lead</th>
                                    <th className="px-2 py-1.5">From → to</th>
                                    <th className="px-2 py-1.5">Result</th>
                                </tr>
                            </thead>
                            <tbody>
                                {res.rows.map((r) => (
                                    <tr key={r.line} className="border-t border-border">
                                        <td className="px-2 py-1">{r.line}</td>
                                        <td className="px-2 py-1">{r.dealer ?? r.lead_id ?? "—"}</td>
                                        <td className="px-2 py-1">{r.from ?? "—"} → {r.to ?? "—"}</td>
                                        <td className="px-2 py-1">{r.result}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {res.more && <p className="text-xs text-ink-muted">Showing the first 500 rows.</p>}
                </div>
            )}
        </section>
    );
}
