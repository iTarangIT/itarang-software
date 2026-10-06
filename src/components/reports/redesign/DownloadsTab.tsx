"use client";

// Reports › Data downloads, in the design's layout: datasets grouped down the
// left, the chosen one on the right with its filters, grouped column boxes,
// the live row count and the download buttons. Behaviour is the existing
// download pipeline (/api/admin/data-downloads): same counts, same files, same
// phone masking, background email for big files, column sets and the log.
//
// A link can open it pre-set: ?section=downloads&dataset=leads&from=…&to=…
// Any extra parameter on such a link is kept and shown as a chip, so the
// person sees every filter the file was cut with.

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Download, Mail, X } from "lucide-react";
import type { DatasetInfo } from "@/lib/exports/datasets/types";
import type { DownloadLogRow } from "@/lib/exports/downloadLog";
import { DATASET_LAYOUT, DATASET_SECTIONS, groupColumns } from "@/lib/exports/datasets/layout";
import { fmtNum } from "@/lib/reports/analysesShared";
import { BTN_OUTLINE, BTN_SOLID, C, CARD, EYEBROW, ErrorLine, Loading, PANEL, RuleLine, SELECT, TH, getJson } from "./ui";

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

/** Parameters the controls below own; anything else from a link is shown as a chip. */
const CONTROLLED = new Set(["section", "dataset", "date_field", "from", "to", "team", "person", "state"]);

const LINKED_LABEL: Record<string, (v: string) => string> = {
    contactability: (v) => (v === "include" ? "Dead and disqualified included" : v === "only" ? "Dead and disqualified only" : `Contactability: ${v}`),
};

export function DownloadsTab() {
    const catalogue = useQuery<Catalogue>({ queryKey: ["data-downloads"], queryFn: () => getJson("/api/admin/data-downloads") });
    const datasets = useMemo(() => catalogue.data?.datasets ?? [], [catalogue.data]);
    const linked = useSearchParams();

    const [datasetId, setDatasetId] = useState(() => linked.get("dataset") ?? "");
    const [values, setValues] = useState<Record<string, string>>(() =>
        Object.fromEntries([...linked.entries()].filter(([k]) => k !== "section" && k !== "dataset")),
    );
    const [ticked, setTicked] = useState<Record<string, string[]>>({});
    const [fullPhone, setFullPhone] = useState(false);
    const [reason, setReason] = useState("");
    const [busy, setBusy] = useState<"xlsx" | "csv" | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
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
    const log = useQuery<{ downloads: DownloadLogRow[]; everyone: boolean }>({
        queryKey: ["data-download-log-mine"],
        queryFn: () => getJson("/api/admin/data-downloads/log"),
    });

    const set = (key: string, value: string) => setValues((prev) => ({ ...prev, [key]: value }));
    const drop = (key: string) =>
        setValues((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
        });
    const pick = (id: string) => {
        setDatasetId(id);
        setValues({});
        setError(null);
        setNotice(null);
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
                setNotice(`The file is being prepared. A link will be emailed to ${json.data.sent_to}; it works for ${json.data.link_hours} hours.`);
            } else {
                const blob = await res.blob();
                const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") ?? "")?.[1] ?? `${dataset.id}.${format}`;
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = name;
                a.click();
                URL.revokeObjectURL(url);
            }
            log.refetch();
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(null);
        }
    };

    if (catalogue.isLoading) return <Loading />;
    if (catalogue.error || datasets.length === 0) {
        return <div className={`${PANEL} p-6 text-[13px] ${C.muted}`}>No data downloads are available to your role.</div>;
    }

    const labelOf = (id: string) => datasets.find((d) => d.id === id)?.label ?? id.replace(/_/g, " ");
    const layout = dataset ? DATASET_LAYOUT[dataset.id] : undefined;
    const sections = [
        ...DATASET_SECTIONS.map((s) => ({ name: s as string, items: datasets.filter((d) => DATASET_LAYOUT[d.id]?.section === s) })),
        { name: "OTHER", items: datasets.filter((d) => !DATASET_LAYOUT[d.id]) },
    ].filter((g) => g.items.length > 0);

    const hasPhone = dataset?.sheets.some((s) => s.columns.some((c) => c.kind === "phone")) ?? false;
    const overCap = count.data?.over_cap === true;
    const rowCap = catalogue.data?.row_cap ?? 50000;
    const backgroundCap = catalogue.data?.background_row_cap ?? 500000;
    const linkHours = catalogue.data?.background_link_hours ?? 24;
    const canBackground = overCap && !!dataset?.background && (count.data?.count ?? 0) <= backgroundCap;
    const needsReason = fullPhone && reason.trim().length < 5;
    const common = dataset?.commonFilters ?? [];
    const showPeople = !dataset?.own_only && (catalogue.data?.people.length ?? 0) > 0;
    const ownKeys = new Set((dataset?.filters ?? []).map((f) => f.key));
    const linkedChips = Object.entries(params).filter(([k]) => !CONTROLLED.has(k) && !ownKeys.has(k));
    const colCount = keepSet.size || allKeys.length;
    const otherSheets = (dataset?.sheets.length ?? 1) - 1;

    const rules = [
        { t: "Same definitions.", d: "Every column follows the metric definitions, so a download adds up to the dashboard for the same filters." },
        { t: "Excel or CSV.", d: "Excel carries a sheet called \"About this file\": filters used, who downloaded it, when, row count and what each column means." },
        {
            t: "Big files by email.",
            d: `Up to ${fmtNum(rowCap)} rows downloads at once. Larger files are prepared in the background and emailed as a link valid for ${linkHours} hours.`,
        },
        { t: "Phone numbers masked.", d: "Full numbers only for Admin and CEO, after typing a reason. Reps download only their own rows." },
        { t: "Every download recorded.", d: "Who, which dataset, which filters, how many rows, and whether phone numbers were included." },
        { t: "Column sets.", d: "Save the columns you use as your own set; it opens that way next time." },
    ];

    return (
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
            {/* Dataset rail */}
            <div className={`${CARD} flex flex-col gap-3.5 p-4`}>
                <span className={`${EYEBROW} px-1.5`}>{datasets.length} DATASETS</span>
                {sections.map((g) => (
                    <div key={g.name} className="flex flex-col gap-0.5">
                        <span className="px-1.5 pb-1 pt-1.5 text-[11px] font-bold tracking-[0.1em] text-[#165e73]">{g.name}</span>
                        {g.items.map((d) => {
                            const on = d.id === datasetId;
                            return (
                                <button
                                    key={d.id}
                                    type="button"
                                    aria-pressed={on}
                                    onClick={() => pick(d.id)}
                                    className={`flex min-h-[48px] flex-col items-start gap-0.5 rounded-[10px] px-2.5 py-[7px] text-left transition ${
                                        on ? "bg-[#e7f3fa]" : "hover:bg-[#f4f7fa]"
                                    }`}
                                >
                                    <span className={`text-[14px] font-semibold ${on ? C.ink : C.text}`}>{d.label}</span>
                                    <span className={`text-[11.5px] ${C.muted}`}>
                                        {DATASET_LAYOUT[d.id]?.grain ?? d.description}
                                        {d.own_only ? " · your rows only" : ""}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                ))}
            </div>

            <div className="flex min-w-0 flex-col gap-[18px]">
                {dataset && (
                    <div className={`${CARD} flex flex-col gap-4 px-4 py-5 md:px-6 md:py-[22px]`}>
                        <div className="flex flex-col gap-1">
                            <h2 className={`m-0 text-[22px] font-bold ${C.ink}`}>{dataset.label}</h2>
                            <span className={`text-[14px] ${C.text}`}>
                                {layout?.grain ? `${layout.grain}. ` : ""}
                                {dataset.description}
                            </span>
                            <span className={`text-[12.5px] ${C.muted}`}>
                                Who can download: {layout?.who ?? "—"}
                                {dataset.own_only ? " · you get your own rows only" : ""}
                            </span>
                        </div>

                        {/* Filters */}
                        <div className="flex flex-col gap-2.5 rounded-xl border border-[#e3e8ef] bg-[#f8fafc] p-4">
                            <span className={EYEBROW}>FILTERS</span>
                            <div className="flex flex-wrap items-center gap-2.5">
                                {dataset.dateFields.length > 0 && (
                                    <>
                                        {dataset.dateFields.length > 1 && (
                                            <label className={`flex items-center gap-2 text-[13px] ${C.muted}`}>
                                                Date
                                                <select
                                                    value={values.date_field ?? dataset.dateFields[0].value}
                                                    onChange={(e) => set("date_field", e.target.value)}
                                                    className={SELECT}
                                                >
                                                    {dataset.dateFields.map((f) => (
                                                        <option key={f.value} value={f.value}>
                                                            {f.label}
                                                        </option>
                                                    ))}
                                                </select>
                                            </label>
                                        )}
                                        <span className="flex min-h-[40px] items-center gap-2 rounded-[10px] border border-[#d5dde6] bg-white px-3 text-[13px]">
                                            {dataset.dateFields.length === 1 && <span className={C.muted}>{dataset.dateFields[0].label}</span>}
                                            <input type="date" aria-label="From" value={values.from ?? ""} onChange={(e) => set("from", e.target.value)} className="bg-transparent focus:outline-none" />
                                            <span className={C.muted}>–</span>
                                            <input type="date" aria-label="To" value={values.to ?? ""} onChange={(e) => set("to", e.target.value)} className="bg-transparent focus:outline-none" />
                                        </span>
                                    </>
                                )}
                                {showPeople && common.includes("team") && (
                                    <select aria-label="Team" value={values.team ?? ""} onChange={(e) => set("team", e.target.value)} className={SELECT}>
                                        <option value="">Team: All</option>
                                        <option value="field">Team: Field (ASM)</option>
                                        <option value="inside">Team: Inside sales</option>
                                    </select>
                                )}
                                {showPeople && common.includes("person") && (
                                    <select aria-label="Person" value={values.person ?? ""} onChange={(e) => set("person", e.target.value)} className={`${SELECT} max-w-[240px]`}>
                                        <option value="">Person: All</option>
                                        {(catalogue.data?.people ?? []).map((p) => (
                                            <option key={p.id} value={p.id}>
                                                {p.name ?? p.id} ({p.role.replace(/_/g, " ")})
                                            </option>
                                        ))}
                                    </select>
                                )}
                                {common.includes("state") && (
                                    <input aria-label="State" placeholder="State: All" value={values.state ?? ""} onChange={(e) => set("state", e.target.value)} className={`${SELECT} w-36`} />
                                )}
                                {dataset.filters.map((f) =>
                                    f.type === "select" ? (
                                        <select key={f.key} aria-label={f.label} value={values[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} className={`${SELECT} max-w-[280px]`}>
                                            <option value="">{f.label}: All</option>
                                            {(f.options ?? []).map((o) => (
                                                <option key={o.value} value={o.value}>
                                                    {f.label}: {o.label}
                                                </option>
                                            ))}
                                        </select>
                                    ) : (
                                        <input
                                            key={f.key}
                                            aria-label={f.label}
                                            placeholder={f.label}
                                            value={values[f.key] ?? ""}
                                            onChange={(e) => set(f.key, e.target.value)}
                                            className={`${SELECT} min-w-[200px] flex-1`}
                                        />
                                    ),
                                )}
                                {linkedChips.map(([k, v]) => (
                                    <span key={k} className="flex min-h-[36px] items-center gap-1.5 rounded-full bg-[#e7f3fa] px-3 text-[12.5px] text-[#02314e]">
                                        {LINKED_LABEL[k]?.(v) ?? `${k.replace(/_/g, " ")}: ${v}`}
                                        <button type="button" aria-label={`Remove ${k}`} onClick={() => drop(k)} className="text-[#5a6877] hover:text-[#02314e]">
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    </span>
                                ))}
                            </div>
                            <span className={`text-[12px] ${C.muted}`}>
                                {dataset.dateFields.length > 0 && !values.from && !values.to
                                    ? dataset.id === "leads" || dataset.allWhenNoDates
                                        ? "No date range set: every row matching the filters. "
                                        : "No date range set: this month. "
                                    : ""}
                                Dates are IST days. Reps only ever see their own rows.
                            </span>
                        </div>

                        {/* Columns */}
                        <div className="flex flex-col gap-3">
                            <div className="flex flex-wrap items-baseline justify-between gap-3">
                                <span className={EYEBROW}>
                                    COLUMNS · {allKeys.length} · {trimmed ? `${keepSet.size} TICKED` : "ALL TICKED"}
                                </span>
                                <span className="flex items-center gap-3 text-[12px]">
                                    {trimmed && (
                                        <button type="button" className="font-semibold text-[#138fc6]" onClick={() => setTicked((p) => ({ ...p, [dataset.id]: allKeys }))}>
                                            Tick all
                                        </button>
                                    )}
                                    {otherSheets > 0 && (
                                        <span className={C.muted}>
                                            Excel also carries {dataset.sheets.slice(1).map((s) => s.name).join(", ")} with all their columns.
                                        </span>
                                    )}
                                </span>
                            </div>
                            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 xl:grid-cols-3">
                                {groupColumns(dataset.id, mainColumns).map((g) => (
                                    <div key={g.name} className="flex flex-col gap-1.5 rounded-xl border border-[#e3e8ef] p-3.5">
                                        <span className={`text-[12.5px] font-bold ${C.ink}`}>{g.name}</span>
                                        {g.columns.map((c) => (
                                            <label key={c.key} className="flex min-h-[26px] items-start gap-2 text-[13px] text-[#1a2733]" title={c.meaning}>
                                                <input
                                                    type="checkbox"
                                                    checked={keepSet.has(c.key)}
                                                    onChange={() => toggleColumn(c.key)}
                                                    className="mt-[3px] accent-[#02314e]"
                                                />
                                                <span className="flex flex-col gap-px">
                                                    <span>{c.header}</span>
                                                    <span className={`text-[11.5px] ${C.muted}`}>{c.meaning}</span>
                                                </span>
                                            </label>
                                        ))}
                                    </div>
                                ))}
                            </div>
                        </div>

                        {hasPhone && catalogue.data?.can_full_phone && (
                            <div className="flex flex-col gap-2 text-[13px]">
                                <label className="flex items-center gap-2">
                                    <input type="checkbox" checked={fullPhone} onChange={(e) => setFullPhone(e.target.checked)} className="accent-[#02314e]" />
                                    Include full phone numbers (otherwise masked, 98xxxxx343)
                                </label>
                                {fullPhone && (
                                    <input
                                        value={reason}
                                        onChange={(e) => setReason(e.target.value)}
                                        placeholder="Reason for full phone numbers (recorded in the download log)"
                                        className={`${SELECT} w-full max-w-xl`}
                                    />
                                )}
                            </div>
                        )}

                        {overCap && (
                            <p className={`flex items-center gap-2 text-[13px] ${canBackground ? C.text : "text-[#b42318]"}`}>
                                <AlertTriangle className="h-4 w-4" />
                                {canBackground
                                    ? `More than ${fmtNum(rowCap)} rows: too large to download at once. It can be prepared in the background and emailed to you as a link that works for ${linkHours} hours.`
                                    : `More than ${fmtNum(dataset.background ? backgroundCap : rowCap)} rows: narrow the date range or the filters to download.`}
                            </p>
                        )}
                        {error && <ErrorLine message={error} />}
                        {notice && <p className="text-[13px] text-[#1e7e34]">{notice}</p>}

                        {/* Action bar */}
                        <div className="flex flex-col gap-3 rounded-xl bg-[#e7f3fa] px-4 py-3.5 md:flex-row md:items-center md:justify-between">
                            <div className="flex flex-col gap-[3px]">
                                <span className={`text-[15px] font-bold ${C.ink}`}>
                                    {count.isLoading
                                        ? "Counting rows…"
                                        : count.error
                                          ? "Could not count rows"
                                          : `${fmtNum(count.data?.count ?? 0)} rows · ${colCount} columns`}
                                </span>
                                <span className="text-[12.5px] text-[#165e73]">
                                    {count.error
                                        ? (count.error as Error).message
                                        : hasPhone
                                          ? fullPhone
                                              ? "Full phone numbers, with your reason. The download is logged."
                                              : "Phone numbers masked (98xxxxx343). Full numbers need a reason and are logged."
                                          : "No phone numbers in this dataset. Download is logged."}
                                </span>
                            </div>
                            <div className="flex flex-wrap gap-2.5">
                                <button type="button" className={BTN_OUTLINE} disabled={savingColumns || keepSet.size === 0} onClick={saveColumns}>
                                    {savingColumns ? "Saving…" : "Save as my column set"}
                                </button>
                                {canBackground ? (
                                    <>
                                        <button type="button" className={BTN_OUTLINE} disabled={!!busy || needsReason} onClick={() => download("csv", true)}>
                                            <Mail className="h-4 w-4" /> {busy === "csv" ? "Starting…" : "Email me the CSV"}
                                        </button>
                                        <button type="button" className={BTN_SOLID} disabled={!!busy || needsReason} onClick={() => download("xlsx", true)}>
                                            <Mail className="h-4 w-4" /> {busy === "xlsx" ? "Starting…" : "Email me the Excel"}
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <button
                                            type="button"
                                            className={BTN_OUTLINE}
                                            disabled={!!busy || overCap || needsReason || count.isLoading || !!count.error}
                                            onClick={() => download("csv")}
                                        >
                                            <Download className="h-4 w-4" /> {busy === "csv" ? "Preparing…" : "Download CSV"}
                                        </button>
                                        <button
                                            type="button"
                                            className={BTN_SOLID}
                                            disabled={!!busy || overCap || needsReason || count.isLoading || !!count.error}
                                            onClick={() => download("xlsx")}
                                        >
                                            <Download className="h-4 w-4" /> {busy === "xlsx" ? "Preparing…" : "Download Excel"}
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                <div className="grid grid-cols-1 gap-[18px] xl:grid-cols-2">
                    <div className={`${PANEL} flex flex-col gap-2.5 px-[22px] py-5`}>
                        <h3 className={`m-0 text-[16px] font-bold ${C.ink}`}>How every download works</h3>
                        {rules.map((r) => (
                            <RuleLine key={r.t} title={r.t}>
                                {r.d}
                            </RuleLine>
                        ))}
                    </div>
                    <div className={`${PANEL} flex min-w-0 flex-col gap-2.5 px-[22px] py-5`}>
                        <div className="flex items-baseline justify-between gap-3">
                            <h3 className={`m-0 text-[16px] font-bold ${C.ink}`}>Recent downloads</h3>
                            <span className={`text-[12px] ${C.muted}`}>{log.data?.everyone ? "Everyone's" : "Yours"} · Admin and CEO see everyone&apos;s</span>
                        </div>
                        <div className={`grid grid-cols-[1.1fr_1fr_0.7fr_1fr] gap-2 border-b border-[#e3e8ef] pb-1.5 ${TH}`}>
                            <span>Who</span>
                            <span>Dataset</span>
                            <span className="text-right">Rows</span>
                            <span>Phone numbers</span>
                        </div>
                        {log.isLoading && <Loading />}
                        {(log.data?.downloads ?? []).slice(0, 8).map((x) => (
                            <div key={x.id} className="grid min-h-[38px] grid-cols-[1.1fr_1fr_0.7fr_1fr] items-center gap-2 border-b border-[#f1f4f7] text-[12.5px]">
                                <span className="flex flex-col">
                                    <span className="font-semibold">{x.user_name ?? "—"}</span>
                                    <span className={`text-[11px] ${C.muted}`}>
                                        {new Date(x.created_at).toLocaleString("en-IN", {
                                            timeZone: "Asia/Kolkata",
                                            day: "numeric",
                                            month: "short",
                                            hour: "2-digit",
                                            minute: "2-digit",
                                        })}
                                    </span>
                                </span>
                                <span>
                                    {labelOf(x.dataset)}
                                    {x.own_only ? " (own)" : ""}
                                </span>
                                <span className="text-right tabular-nums">{fmtNum(x.row_count)}</span>
                                <span className={x.full_phone ? "text-[#b45309]" : C.muted}>
                                    {x.full_phone ? `Full${x.reason ? ` · "${x.reason}"` : ""}` : hasPhoneColumn(datasets, x.dataset) ? "Masked" : "None in dataset"}
                                </span>
                            </div>
                        ))}
                        {!log.isLoading && (log.data?.downloads ?? []).length === 0 && (
                            <span className={`py-4 text-[12.5px] ${C.muted}`}>No downloads recorded yet.</span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

function hasPhoneColumn(datasets: DatasetInfo[], id: string): boolean {
    const d = datasets.find((x) => x.id === id);
    return !!d?.sheets.some((s) => s.columns.some((c) => c.kind === "phone"));
}
