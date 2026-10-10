"use client";

// Reports › Data downloads (tracker ID 13). One catalogue of datasets that all
// download the same way: pick a dataset, set the date range and filters, tick
// the columns to keep, see how many rows match, then download Excel (with an
// "About this file" sheet) or CSV. A file too large to download at once is
// prepared in the background and emailed as a link. Phone numbers are masked
// unless an Admin or CEO asks for full numbers and types a reason. Every
// download is logged.
//
// A page button can open this tab with a dataset and filters pre-set:
//   /admin/reports?section=downloads&dataset=visits&from=2026-09-01&person=<id>

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Download, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DatasetInfo } from "@/lib/exports/datasets/types";
import { MultiSelectFilter } from "@/components/reports/MultiSelectFilter";
import type { DownloadLogRow } from "@/lib/exports/downloadLog";

type Catalogue = {
    datasets: (DatasetInfo & { own_only: boolean })[];
    people: { id: string; name: string | null; role: string }[];
    saved_columns: Record<string, string[]>;
    row_cap: number;
    background_row_cap: number;
    background_link_hours: number;
    can_full_phone: boolean;
    can_see_log: boolean;
};

const inputCls = "h-9 rounded-md border border-border bg-surface px-2 text-sm";
const labelCls = "block text-[10px] font-medium uppercase tracking-wide text-ink-muted mb-1";
const NOT_FILTERS = new Set(["section", "dataset"]);

async function getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { cache: "no-store" });
    const json = await res.json();
    if (!res.ok || !json.success) throw new Error(json?.error?.message ?? "Request failed");
    return json.data as T;
}

export function DataDownloadsView() {
    const catalogue = useQuery<Catalogue>({ queryKey: ["data-downloads"], queryFn: () => getJson("/api/admin/data-downloads") });
    const datasets = catalogue.data?.datasets ?? [];
    const linked = useSearchParams();

    const [datasetId, setDatasetId] = useState(() => linked.get("dataset") ?? "");
    const [values, setValues] = useState<Record<string, string>>(() =>
        Object.fromEntries([...linked.entries()].filter(([k]) => !NOT_FILTERS.has(k))),
    );
    // Ticked columns per dataset, once the person has touched them; until then the saved set, else all.
    const [ticked, setTicked] = useState<Record<string, string[]>>({});
    const [fullPhone, setFullPhone] = useState(false);
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState<"xlsx" | "csv" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [showColumns, setShowColumns] = useState(false);
    const [savingColumns, setSavingColumns] = useState(false);

    useEffect(() => {
        if (datasets.length > 0 && !datasets.some((d) => d.id === datasetId)) setDatasetId(datasets[0].id);
    }, [datasetId, datasets]);

    const dataset = datasets.find((d) => d.id === datasetId);
    const params = useMemo(() => {
        const p: Record<string, string> = {};
        for (const [k, v] of Object.entries(values)) if (v.trim()) p[k] = v.trim();
        return p;
    }, [values]);
    const qs = new URLSearchParams(params).toString();

    const count = useQuery<{ count: number; over_cap: boolean; own_only: boolean }>({
        enabled: !!dataset,
        queryKey: ["data-download-count", datasetId, qs],
        queryFn: () => getJson(`/api/admin/data-downloads/${datasetId}${qs ? `?${qs}` : ""}`),
    });

    const log = useQuery<{ downloads: DownloadLogRow[] }>({
        enabled: !!catalogue.data?.can_see_log,
        queryKey: ["data-download-log"],
        queryFn: () => getJson("/api/admin/data-downloads/log"),
    });

    const set = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }));
    const pick = (id: string) => {
        setDatasetId(id);
        setValues({});
        setError(null);
        setNotice(null);
        setShowColumns(false);
    };

    const mainColumns = dataset?.sheets[0].columns ?? [];
    const allKeys = mainColumns.map((c) => c.key);
    const keep = (dataset && (ticked[dataset.id] ?? catalogue.data?.saved_columns[dataset.id])) || allKeys;
    const keepSet = new Set(keep.filter((k) => allKeys.includes(k)));
    const trimmed = keepSet.size > 0 && keepSet.size < allKeys.length;
    const toggleColumn = (key: string) => {
        if (!dataset) return;
        const next = new Set(keepSet);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        setTicked((prev) => ({ ...prev, [dataset.id]: allKeys.filter((k) => next.has(k)) }));
    };
    const saveColumns = async () => {
        if (!dataset) return;
        setSavingColumns(true);
        setError(null);
        try {
            const res = await fetch(`/api/admin/data-downloads/${dataset.id}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ columns: allKeys.filter((k) => keepSet.has(k)) }),
            });
            const json = await res.json().catch(() => null);
            if (!res.ok) throw new Error(json?.error?.message ?? "Could not save the column set.");
            setNotice("Saved. These columns are ticked the next time you open this dataset.");
            catalogue.refetch();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setSavingColumns(false);
        }
    };

    const download = async (format: "xlsx" | "csv", background = false) => {
        if (!dataset) return;
        setBusy(format);
        setError(null);
        setNotice(null);
        try {
            const res = await fetch(`/api/admin/data-downloads/${dataset.id}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    params,
                    format,
                    full_phone: fullPhone,
                    reason: fullPhone ? reason : undefined,
                    columns: trimmed ? allKeys.filter((k) => keepSet.has(k)) : undefined,
                    background,
                }),
            });
            if (!res.ok) {
                const json = await res.json().catch(() => null);
                throw new Error(json?.error?.message ?? "The download failed.");
            }
            if (background) {
                const json = await res.json();
                setNotice(
                    `The file is being prepared. A link will be emailed to ${json.data.sent_to}; it works for ${json.data.link_hours} hours.`,
                );
                return;
            }
            const blob = await res.blob();
            const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `${dataset.id}.${format}`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = name;
            a.click();
            URL.revokeObjectURL(url);
            log.refetch();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(null);
        }
    };

    if (catalogue.isLoading) {
        return (
            <div className="flex items-center py-12 text-ink-muted">
                <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading…
            </div>
        );
    }
    if (catalogue.error || datasets.length === 0) {
        return <p className="rounded-xl border border-border bg-surface p-6 text-sm text-ink-muted">No data downloads are available to your role.</p>;
    }

    const hasPhone = dataset?.sheets.some((s) => s.columns.some((c) => c.kind === "phone")) ?? false;
    const overCap = count.data?.over_cap === true;
    const rowCap = catalogue.data?.row_cap ?? 50000;
    const backgroundCap = catalogue.data?.background_row_cap ?? 500000;
    const canBackground = overCap && !!dataset?.background && (count.data?.count ?? 0) <= backgroundCap;
    const needsReason = fullPhone && reason.trim().length < 5;
    const common = dataset?.commonFilters ?? [];
    const showPeople = !dataset?.own_only && (catalogue.data?.people.length ?? 0) > 0;

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                {datasets.map((d) => (
                    <button
                        key={d.id}
                        type="button"
                        onClick={() => pick(d.id)}
                        className={`rounded-xl border p-4 text-left transition ${
                            d.id === datasetId ? "border-brand-600 bg-brand-600/5" : "border-border bg-surface hover:bg-bg"
                        }`}
                    >
                        <div className="text-sm font-semibold text-ink">{d.label}</div>
                        <p className="mt-1 text-xs text-ink-muted">{d.description}</p>
                        {d.own_only && <p className="mt-2 text-[11px] font-medium text-amber-700">Your own rows only.</p>}
                    </button>
                ))}
            </div>

            {dataset && (
                <div className="rounded-xl border border-border bg-surface shadow-card">
                    <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
                        {dataset.dateFields.length > 0 && (
                            <>
                                {dataset.dateFields.length > 1 && (
                                    <div>
                                        <label className={labelCls}>Date</label>
                                        <select
                                            value={values.date_field ?? dataset.dateFields[0].value}
                                            onChange={(e) => set("date_field", e.target.value)}
                                            className={inputCls}
                                        >
                                            {dataset.dateFields.map((f) => (
                                                <option key={f.value} value={f.value}>
                                                    {f.label}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                                <div>
                                    <label className={labelCls}>From</label>
                                    <input type="date" value={values.from ?? ""} onChange={(e) => set("from", e.target.value)} className={inputCls} />
                                </div>
                                <div>
                                    <label className={labelCls}>To</label>
                                    <input type="date" value={values.to ?? ""} onChange={(e) => set("to", e.target.value)} className={inputCls} />
                                </div>
                            </>
                        )}
                        {showPeople && common.includes("team") && (
                            <div>
                                <label className={labelCls}>Team</label>
                                <select value={values.team ?? ""} onChange={(e) => set("team", e.target.value)} className={inputCls}>
                                    <option value="">Any</option>
                                    <option value="field">Field (ASM)</option>
                                    <option value="inside">Inside sales</option>
                                </select>
                            </div>
                        )}
                        {showPeople && common.includes("person") && (
                            <div>
                                <label className={labelCls}>Person</label>
                                <select value={values.person ?? ""} onChange={(e) => set("person", e.target.value)} className={`${inputCls} max-w-[220px]`}>
                                    <option value="">Anyone</option>
                                    {(catalogue.data?.people ?? []).map((p) => (
                                        <option key={p.id} value={p.id}>
                                            {p.name ?? p.id} ({p.role.replace(/_/g, " ")})
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                        {common.includes("state") && (
                            <div>
                                <label className={labelCls}>State</label>
                                <input value={values.state ?? ""} onChange={(e) => set("state", e.target.value)} className={`${inputCls} w-40`} />
                            </div>
                        )}
                        {dataset.filters.map((f) => (
                            <div key={f.key} className={f.type === "text" ? "min-w-[200px] flex-1" : ""}>
                                <label className={labelCls}>{f.label}</label>
                                {f.type === "multiselect" ? (
                                    <MultiSelectFilter filter={f} value={values[f.key]} onChange={(v) => set(f.key, v)} className={inputCls} />
                                ) : f.type === "select" ? (
                                    <select value={values[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} className={inputCls}>
                                        <option value="">Any</option>
                                        {(f.options ?? []).map((o) => (
                                            <option key={o.value} value={o.value}>
                                                {o.label}
                                            </option>
                                        ))}
                                    </select>
                                ) : (
                                    <input value={values[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} className={`${inputCls} w-full`} />
                                )}
                            </div>
                        ))}
                    </div>

                    <div className="space-y-3 px-4 py-3">
                        {dataset.dateFields.length > 0 && !values.from && !values.to && (
                            <p className="text-xs text-ink-muted">
                                {dataset.id === "leads"
                                    ? "No date range set — every lead matching the filters."
                                    : dataset.allWhenNoDates
                                      ? "No date range set — every row matching the filters."
                                      : "No date range set — this month."}
                            </p>
                        )}

                        <p className="text-sm text-ink">
                            {count.isLoading ? (
                                "Counting rows…"
                            ) : count.error ? (
                                <span className="text-danger">{(count.error as Error).message}</span>
                            ) : (
                                <>
                                    <span className="font-semibold tabular-nums">{(count.data?.count ?? 0).toLocaleString("en-IN")}</span> rows match
                                    {count.data?.own_only ? " (your own rows only)" : ""}.
                                    {trimmed ? ` ${keepSet.size} of ${allKeys.length} columns ticked.` : ""}
                                </>
                            )}
                        </p>
                        {overCap && (
                            <p className={`flex items-center gap-2 text-sm ${canBackground ? "text-ink" : "text-danger"}`}>
                                <AlertTriangle className="h-4 w-4" />
                                {canBackground
                                    ? `More than ${rowCap.toLocaleString("en-IN")} rows — too large to download at once. It can be prepared in the background and emailed to you as a link that works for ${catalogue.data?.background_link_hours ?? 24} hours.`
                                    : `More than ${(dataset.background ? backgroundCap : rowCap).toLocaleString("en-IN")} rows — narrow the date range or the filters to download.`}
                            </p>
                        )}

                        {hasPhone && (
                            <div className="text-sm text-ink">
                                {catalogue.data?.can_full_phone ? (
                                    <>
                                        <label className="flex items-center gap-2">
                                            <input type="checkbox" checked={fullPhone} onChange={(e) => setFullPhone(e.target.checked)} />
                                            Include full phone numbers (otherwise masked, 98xxxxx343)
                                        </label>
                                        {fullPhone && (
                                            <input
                                                value={reason}
                                                onChange={(e) => setReason(e.target.value)}
                                                placeholder="Reason for full phone numbers (recorded in the download log)"
                                                className={`${inputCls} mt-2 w-full max-w-xl`}
                                            />
                                        )}
                                    </>
                                ) : (
                                    <span className="text-xs text-ink-muted">Phone numbers are masked (98xxxxx343). Full numbers are for Admin and CEO only.</span>
                                )}
                            </div>
                        )}

                        {error && (
                            <p className="flex items-center gap-2 text-sm text-danger">
                                <AlertTriangle className="h-4 w-4" />
                                {error}
                            </p>
                        )}
                        {notice && <p className="text-sm text-emerald-700">{notice}</p>}

                        <div className="flex flex-wrap items-center gap-2">
                            {canBackground ? (
                                <>
                                    <Button type="button" size="sm" disabled={!!busy || needsReason} onClick={() => download("xlsx", true)}>
                                        <Mail className="mr-1 h-3.5 w-3.5" />
                                        {busy === "xlsx" ? "Starting…" : "Prepare Excel and email me the link"}
                                    </Button>
                                    <Button type="button" size="sm" variant="outline" disabled={!!busy || needsReason} onClick={() => download("csv", true)}>
                                        <Mail className="mr-1 h-3.5 w-3.5" />
                                        {busy === "csv" ? "Starting…" : "Prepare CSV and email me the link"}
                                    </Button>
                                </>
                            ) : (
                                <>
                                    <Button type="button" size="sm" disabled={!!busy || overCap || needsReason || count.isLoading} onClick={() => download("xlsx")}>
                                        <Download className="mr-1 h-3.5 w-3.5" />
                                        {busy === "xlsx" ? "Preparing…" : "Download Excel"}
                                    </Button>
                                    <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        disabled={!!busy || overCap || needsReason || count.isLoading}
                                        onClick={() => download("csv")}
                                    >
                                        <Download className="mr-1 h-3.5 w-3.5" />
                                        {busy === "csv" ? "Preparing…" : dataset.sheets.length > 1 ? `Download CSV (${dataset.sheets[0].name} sheet only)` : "Download CSV"}
                                    </Button>
                                </>
                            )}
                            <button type="button" className="text-sm text-brand-600 underline" onClick={() => setShowColumns((v) => !v)}>
                                {showColumns ? "Hide columns" : "Choose columns and see what each means"}
                            </button>
                        </div>

                        {showColumns &&
                            dataset.sheets.map((s, sheetIndex) => (
                                <div key={s.name} className="overflow-x-auto rounded-lg border border-border">
                                    <table className="min-w-full text-xs">
                                        <thead className="bg-bg text-left text-ink-muted">
                                            <tr>
                                                {sheetIndex === 0 && <th className="w-8 px-3 py-2 font-semibold">Keep</th>}
                                                <th className="px-3 py-2 font-semibold">{dataset.sheets.length > 1 ? `${s.name} — column` : "Column"}</th>
                                                <th className="px-3 py-2 font-semibold">Meaning</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-border">
                                            {s.columns.map((c) => (
                                                <tr key={c.key}>
                                                    {sheetIndex === 0 && (
                                                        <td className="px-3 py-1.5">
                                                            <input
                                                                type="checkbox"
                                                                aria-label={`Keep ${c.header}`}
                                                                checked={keepSet.has(c.key)}
                                                                onChange={() => toggleColumn(c.key)}
                                                            />
                                                        </td>
                                                    )}
                                                    <td className="whitespace-nowrap px-3 py-1.5 font-medium text-ink">{c.header}</td>
                                                    <td className="px-3 py-1.5 text-ink-muted">{c.meaning}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                    {sheetIndex === 0 && (
                                        <div className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2">
                                            <Button type="button" size="sm" variant="outline" disabled={savingColumns || keepSet.size === 0} onClick={saveColumns}>
                                                {savingColumns ? "Saving…" : "Save as my column set"}
                                            </Button>
                                            <button
                                                type="button"
                                                className="text-xs text-brand-600 underline"
                                                onClick={() => setTicked((prev) => ({ ...prev, [dataset.id]: allKeys }))}
                                            >
                                                Tick all
                                            </button>
                                            {keepSet.size === 0 && <span className="text-xs text-danger">Tick at least one column.</span>}
                                            {dataset.sheets.length > 1 && (
                                                <span className="text-xs text-ink-muted">The other sheets always carry all their columns.</span>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ))}
                    </div>
                </div>
            )}

            {catalogue.data?.can_see_log && (
                <div className="rounded-xl border border-border bg-surface shadow-card">
                    <div className="border-b border-border px-4 py-3">
                        <h3 className="text-sm font-semibold text-ink">Download log</h3>
                        <p className="text-xs text-ink-muted">Every download, newest first: who, what, how many rows, and whether it carried full phone numbers.</p>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="min-w-full text-xs">
                            <thead className="bg-bg text-left text-ink-muted">
                                <tr>
                                    <th className="px-3 py-2 font-semibold">When</th>
                                    <th className="px-3 py-2 font-semibold">Who</th>
                                    <th className="px-3 py-2 font-semibold">Dataset</th>
                                    <th className="px-3 py-2 text-right font-semibold">Rows</th>
                                    <th className="px-3 py-2 font-semibold">Phone numbers</th>
                                    <th className="px-3 py-2 font-semibold">Reason</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-border">
                                {(log.data?.downloads ?? []).map((d) => (
                                    <tr key={d.id}>
                                        <td className="whitespace-nowrap px-3 py-1.5 text-ink-muted">
                                            {new Date(d.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                                        </td>
                                        <td className="px-3 py-1.5 text-ink">
                                            {d.user_name ?? "—"} <span className="text-ink-muted">({d.user_role ?? "—"})</span>
                                        </td>
                                        <td className="px-3 py-1.5 text-ink">
                                            {d.dataset}
                                            {d.format ? ` · ${d.format}` : ""}
                                            {d.own_only ? " · own rows" : ""}
                                            {d.filters?.background ? " · background" : ""}
                                        </td>
                                        <td className="px-3 py-1.5 text-right tabular-nums">{d.row_count.toLocaleString("en-IN")}</td>
                                        <td className={`px-3 py-1.5 ${d.full_phone ? "font-semibold text-danger" : "text-ink-muted"}`}>{d.full_phone ? "Full" : "Masked"}</td>
                                        <td className="px-3 py-1.5 text-ink-muted">{d.reason ?? "—"}</td>
                                    </tr>
                                ))}
                                {!log.isLoading && (log.data?.downloads ?? []).length === 0 && (
                                    <tr>
                                        <td colSpan={6} className="px-3 py-6 text-center text-ink-muted">
                                            No downloads recorded yet.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
}
