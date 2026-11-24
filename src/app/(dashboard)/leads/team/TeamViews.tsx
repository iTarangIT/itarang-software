"use client";

// 24 Nov (CRM items 5 + 7): the manager's Team leads and Team visits pages.
// Both read their filters from the URL (so a link keeps them) and fetch
// /api/team/leads or /api/team/visits; "Download CSV" is the same URL with
// format=csv.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download, Loader2 } from "lucide-react";
import { BUSINESS_TYPE_OPTIONS, BUSINESS_TYPE_UNSET, businessTypeLabel, businessTypeTone } from "@/lib/leads/businessType";
import { LEAD_SEGMENTS, storedSegments } from "@/lib/leads/segments";
import { LEAD_STATUS_LABEL, LEAD_STATUS_OPTIONS } from "@/lib/leads/queueFilters";
import { VISIT_KIND_LABELS, VISIT_KINDS, addDays, istToday, type VisitKind } from "@/lib/team/teamFilters";
import type { TeamLeadRow, TeamVisitRow } from "@/lib/team/teamLeads";

type Person = { id: string; name: string };

const IST = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
});
const when = (iso: string | null) => (iso ? IST.format(new Date(iso)) : "—");
const words = (v: string | null | undefined) => (v ? v.replace(/_/g, " ") : "—");
const dayLabel = (d: string | null) =>
    d
        ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
        : "—";

/** The URL query as state: set() replaces the URL, keeping the other params. */
function useQueryState() {
    const sp = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();
    const get = (k: string) => sp.get(k) ?? "";
    const set = (patch: Record<string, string>) => {
        const next = new URLSearchParams(sp.toString());
        for (const [k, v] of Object.entries(patch)) {
            if (v) next.set(k, v);
            else next.delete(k);
        }
        router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    };
    return { sp, get, set };
}
type QueryState = ReturnType<typeof useQueryState>;

function useTeamFetch<T>(url: string) {
    const [data, setData] = useState<T | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    useEffect(() => {
        let live = true;
        setLoading(true);
        setError(null);
        fetch(url)
            .then(async (r) => {
                const j = await r.json().catch(() => null);
                if (!r.ok || !j?.success) throw new Error(j?.error?.message ?? "Could not load the list");
                if (live) setData(j.data as T);
            })
            .catch((e: Error) => {
                if (live) setError(e.message);
            })
            .finally(() => {
                if (live) setLoading(false);
            });
        return () => {
            live = false;
        };
    }, [url]);
    return { data, error, loading };
}

const selectCls = "rounded-md border border-gray-200 bg-white px-2.5 py-1.5 text-sm";

function CommonFilters({ q, people }: { q: QueryState; people: Person[] }) {
    const [city, setCity] = useState(q.get("city"));
    return (
        <>
            <label className="text-xs text-gray-600">
                <span className="block">Team member</span>
                <select className={selectCls} value={q.get("member")} onChange={(e) => q.set({ member: e.target.value })}>
                    <option value="">Everyone</option>
                    {people.map((p) => (
                        <option key={p.id} value={p.id}>
                            {p.name}
                        </option>
                    ))}
                </select>
            </label>
            <label className="text-xs text-gray-600">
                <span className="block">Type of business</span>
                <select
                    className={selectCls}
                    value={q.get("business_type")}
                    onChange={(e) => q.set({ business_type: e.target.value })}
                >
                    <option value="">All</option>
                    {BUSINESS_TYPE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                            {o.label}
                        </option>
                    ))}
                    <option value={BUSINESS_TYPE_UNSET}>Not set</option>
                </select>
            </label>
            <label className="text-xs text-gray-600">
                <span className="block">Segment</span>
                <select className={selectCls} value={q.get("segment")} onChange={(e) => q.set({ segment: e.target.value })}>
                    <option value="">All</option>
                    {LEAD_SEGMENTS.map((s) => (
                        <option key={s} value={s}>
                            {s}
                        </option>
                    ))}
                </select>
            </label>
            <label className="text-xs text-gray-600">
                <span className="block">City</span>
                <input
                    className={`${selectCls} w-32`}
                    value={city}
                    placeholder="Any"
                    onChange={(e) => setCity(e.target.value)}
                    onBlur={() => q.set({ city: city.trim() })}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") q.set({ city: city.trim() });
                    }}
                />
            </label>
        </>
    );
}

function DateRange({ q, from, to, label }: { q: QueryState; from: string; to: string; label: string }) {
    return (
        <div className="text-xs text-gray-600">
            <span className="block">{label}</span>
            <div className="flex items-center gap-1">
                <input type="date" className={selectCls} value={from} onChange={(e) => q.set({ from: e.target.value })} />
                <span>to</span>
                <input type="date" className={selectCls} value={to} onChange={(e) => q.set({ to: e.target.value })} />
            </div>
        </div>
    );
}

function DownloadLink({ href }: { href: string }) {
    return (
        <a
            href={href}
            className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
            <Download className="h-4 w-4" />
            Download CSV
        </a>
    );
}

function Shell({
    loading,
    error,
    truncated,
    count,
    children,
}: {
    loading: boolean;
    error: string | null;
    truncated?: boolean;
    count: number;
    children: React.ReactNode;
}) {
    if (error) return <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>;
    return (
        <div className="space-y-2">
            <p className="flex items-center gap-2 text-xs text-gray-500">
                {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {count} {count === 1 ? "row" : "rows"}
                {truncated ? " — showing the first 500; narrow the filters or download the CSV for all." : ""}
            </p>
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">{children}</div>
        </div>
    );
}

const th = "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500 whitespace-nowrap";
const td = "px-3 py-2 align-top text-sm text-gray-800";

function BizChip({ v, segments }: { v: string | null; segments?: unknown }) {
    const segs = storedSegments(segments);
    return (
        <>
            <span className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium ${businessTypeTone(v)}`}>
                {businessTypeLabel(v)}
            </span>
            {segs.length > 0 && <span className="text-[11px] text-gray-600">{segs.join(" · ")}</span>}
        </>
    );
}

// ── Team leads (item 5) ─────────────────────────────────────────────────────

export function TeamLeadsView({ leadBase }: { leadBase: string }) {
    const q = useQueryState();
    const [search, setSearch] = useState(q.get("q"));
    const query = q.sp.toString();
    const { data, error, loading } = useTeamFetch<{ rows: TeamLeadRow[]; truncated: boolean; people: Person[] }>(
        `/api/team/leads?${query}`,
    );
    const rows = data?.rows ?? [];
    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white p-3">
                <CommonFilters q={q} people={data?.people ?? []} />
                <label className="text-xs text-gray-600">
                    <span className="block">Status</span>
                    <select className={selectCls} value={q.get("status")} onChange={(e) => q.set({ status: e.target.value })}>
                        <option value="">All</option>
                        {LEAD_STATUS_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                </label>
                <DateRange q={q} from={q.get("from")} to={q.get("to")} label="Latest action between" />
                <label className="text-xs text-gray-600">
                    <span className="block">Search</span>
                    <input
                        className={`${selectCls} w-44`}
                        value={search}
                        placeholder="Name, phone, lead ID"
                        onChange={(e) => setSearch(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") q.set({ q: search.trim() });
                        }}
                        onBlur={() => q.set({ q: search.trim() })}
                    />
                </label>
                <div className="ml-auto">
                    <DownloadLink href={`/api/team/leads?${query ? `${query}&` : ""}format=csv`} />
                </div>
            </div>
            <Shell loading={loading} error={error} truncated={data?.truncated} count={rows.length}>
                <table className="min-w-full divide-y divide-gray-100">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className={th}>Lead</th>
                            <th className={th}>Owner</th>
                            <th className={th}>Status</th>
                            <th className={th}>Latest action</th>
                            <th className={th}>Latest comment</th>
                            <th className={th}>Next follow-up</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {rows.map((r) => (
                            <tr key={r.id} className="hover:bg-gray-50/60">
                                <td className={td}>
                                    <Link href={`${leadBase}${r.id}`} className="font-medium text-emerald-700 hover:underline">
                                        {r.name}
                                    </Link>
                                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                                        {r.city && <span>{r.city}</span>}
                                        <BizChip v={r.business_type} segments={r.segments} />
                                    </div>
                                </td>
                                <td className={td}>{r.owner_name ?? "—"}</td>
                                <td className={td}>
                                    {(LEAD_STATUS_LABEL as Record<string, string>)[r.lead_status ?? ""] ?? words(r.lead_status)}
                                    {r.interest_level && <div className="text-xs capitalize text-gray-500">{r.interest_level}</div>}
                                </td>
                                <td className={td}>
                                    <div className="capitalize">{words(r.last_action_type)}</div>
                                    <div className="text-xs text-gray-500">
                                        {when(r.last_action_at)}
                                        {r.last_action_by ? ` · ${r.last_action_by}` : ""}
                                    </div>
                                </td>
                                <td className={`${td} max-w-md`}>
                                    {r.last_comment ? (
                                        <>
                                            <p className="line-clamp-3 whitespace-pre-wrap" title={r.last_comment}>
                                                {r.last_comment}
                                            </p>
                                            <div className="text-xs text-gray-500">
                                                {when(r.last_comment_at)}
                                                {r.last_comment_by ? ` · ${r.last_comment_by}` : ""}
                                            </div>
                                        </>
                                    ) : (
                                        <span className="text-gray-400">—</span>
                                    )}
                                </td>
                                <td className={`${td} whitespace-nowrap`}>{when(r.next_follow_up_at)}</td>
                            </tr>
                        ))}
                        {!loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={6} className="px-3 py-8 text-center text-sm text-gray-500">
                                    No leads match these filters.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </Shell>
        </div>
    );
}

// ── Team visits (item 7) ────────────────────────────────────────────────────

export function TeamVisitsView({ leadBase }: { leadBase: string }) {
    const q = useQueryState();
    const kind: VisitKind = q.get("kind") === "completed" ? "completed" : "scheduled";
    const today = useMemo(() => istToday(), []);
    const to = q.get("to") || today;
    const from = q.get("from") || addDays(to, -30);
    const params = new URLSearchParams(q.sp.toString());
    params.set("kind", kind);
    params.set("from", from);
    params.set("to", to);
    const query = params.toString();
    const { data, error, loading } = useTeamFetch<{ rows: TeamVisitRow[]; truncated: boolean; people: Person[] }>(
        `/api/team/visits?${query}`,
    );
    const rows = data?.rows ?? [];
    return (
        <div className="space-y-4">
            <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
                {VISIT_KINDS.map((k) => (
                    <button
                        key={k}
                        type="button"
                        onClick={() => q.set({ kind: k })}
                        className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                            kind === k ? "bg-emerald-600 text-white" : "text-gray-700 hover:bg-gray-50"
                        }`}
                    >
                        {VISIT_KIND_LABELS[k]}
                    </button>
                ))}
            </div>
            <div className="flex flex-wrap items-end gap-3 rounded-xl border border-gray-200 bg-white p-3">
                <DateRange q={q} from={from} to={to} label={kind === "completed" ? "Visited between" : "Scheduled for between"} />
                <CommonFilters q={q} people={data?.people ?? []} />
                <div className="ml-auto">
                    <DownloadLink href={`/api/team/visits?${query}&format=csv`} />
                </div>
            </div>
            <Shell loading={loading} error={error} truncated={data?.truncated} count={rows.length}>
                <table className="min-w-full divide-y divide-gray-100">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className={th}>{kind === "completed" ? "Visited on" : "Scheduled for"}</th>
                            <th className={th}>Lead</th>
                            <th className={th}>Rep</th>
                            <th className={th}>{kind === "completed" ? "Outcome" : "Status now"}</th>
                            <th className={th}>Remarks</th>
                            <th className={th}>Next visit</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {rows.map((r) => (
                            <tr key={r.visit_id} className="hover:bg-gray-50/60">
                                <td className={`${td} whitespace-nowrap`}>
                                    {dayLabel(kind === "completed" ? r.actual_visit_date : r.scheduled_date)}
                                    {kind === "completed" && r.verified && (
                                        <div className="text-[11px] text-emerald-700">Photo + location</div>
                                    )}
                                </td>
                                <td className={td}>
                                    <Link href={`${leadBase}${r.lead_id}`} className="font-medium text-emerald-700 hover:underline">
                                        {r.lead_name}
                                    </Link>
                                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-500">
                                        {r.city && <span>{r.city}</span>}
                                        <BizChip v={r.business_type} segments={r.segments} />
                                    </div>
                                </td>
                                <td className={td}>{r.rep_name ?? "—"}</td>
                                <td className={`${td} capitalize`}>
                                    {kind === "completed"
                                        ? words(r.visit_outcome)
                                        : r.visit_status === "visited"
                                          ? `done ${dayLabel(r.actual_visit_date)}`
                                          : words(r.visit_status)}
                                </td>
                                <td className={`${td} max-w-md`}>
                                    <p className="line-clamp-3 whitespace-pre-wrap" title={r.visit_remarks ?? ""}>
                                        {r.visit_remarks || "—"}
                                    </p>
                                </td>
                                <td className={`${td} whitespace-nowrap`}>{dayLabel(r.next_visit_date)}</td>
                            </tr>
                        ))}
                        {!loading && rows.length === 0 && (
                            <tr>
                                <td colSpan={6} className="px-3 py-8 text-center text-sm text-gray-500">
                                    No {kind} visits in this range.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </Shell>
        </div>
    );
}

/** The two tabs at the top of both pages. */
export function TeamTabs({ active }: { active: "leads" | "visits" }) {
    const tab = (href: string, label: string, on: boolean) => (
        <Link
            href={href}
            className={`border-b-2 px-1 pb-2 text-sm font-medium ${
                on ? "border-emerald-600 text-emerald-700" : "border-transparent text-gray-500 hover:text-gray-800"
            }`}
        >
            {label}
        </Link>
    );
    return (
        <nav className="flex gap-5 border-b border-gray-200">
            {tab("/leads/team", "Team leads", active === "leads")}
            {tab("/leads/team/visits", "Team visits", active === "visits")}
        </nav>
    );
}
