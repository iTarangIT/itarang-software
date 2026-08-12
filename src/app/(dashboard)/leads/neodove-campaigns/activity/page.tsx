// NeoDove → Sync Activity (E-224).
//
// Every push we made and every event NeoDove sent back, newest first. This is
// the reconciliation ledger surfaced as a screen: because NeoDove cannot be
// queried, this table is the only evidence the integration is alive, and the
// only place a silent failure becomes visible.
//
// Note this route is a STATIC sibling of [id] — Next resolves /activity here
// rather than treating it as a campaign id. Campaign ids are NDC-YYYYMMDD-NNN,
// so there is no real collision.

"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import {
    AlertTriangle,
    ArrowDownLeft,
    ArrowLeft,
    ArrowUpRight,
    Code2,
    Info,
} from "lucide-react";

type ActivityRow = {
    id: string;
    direction: string;
    event_type: string | null;
    neodove_campaign_id: string | null;
    campaign_name: string | null;
    dealer_lead_id: string | null;
    dealer_name: string | null;
    phone: string | null;
    external_event_id: string | null;
    http_status: number | null;
    error: string | null;
    attempts: number;
    created_at: string;
    request_payload: unknown;
    response_payload: unknown;
};

type Payload = {
    rows: ActivityRow[];
    page: number;
    summary: {
        outbound: number;
        inbound: number;
        errors: number;
        backfilled: number;
    };
};

type Filter = "all" | "outbound" | "inbound";

/**
 * One captured payload, pretty-printed.
 *
 * Note what is NOT here: any attempt to interpret the JSON. The whole value of
 * this block is that it shows NeoDove's bytes exactly as they arrived — the
 * moment it starts reshaping them it stops being evidence of the real contract,
 * which is the one thing this screen exists to provide.
 */
function PayloadBlock({ title, value }: { title: string; value: unknown }) {
    return (
        <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">
                {title}
            </p>
            <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-gray-200 bg-white p-2.5 text-[11px] leading-relaxed text-gray-800">
                {value == null ? "—" : JSON.stringify(value, null, 2)}
            </pre>
        </div>
    );
}

export default function NeodoveActivityPage() {
    const [filter, setFilter] = useState<Filter>("all");
    const [errorsOnly, setErrorsOnly] = useState(false);
    const [page, setPage] = useState(1);
    // Which rows have their raw payload open. A Set rather than a single id so
    // two events can be compared side by side — which is exactly what you do
    // when working out why one webhook parsed and another did not.
    const [openRows, setOpenRows] = useState<Set<string>>(() => new Set());

    const toggleRow = (id: string) =>
        setOpenRows((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const { data, isLoading, isError, error } = useQuery<Payload>({
        queryKey: ["neodove-activity", filter, errorsOnly, page],
        queryFn: async () => {
            const qs = new URLSearchParams({ page: String(page) });
            if (filter !== "all") qs.set("direction", filter);
            if (errorsOnly) qs.set("errorsOnly", "true");
            const res = await fetch(`/api/neodove/activity?${qs}`);
            const json = await res.json();
            if (!json.success) {
                throw new Error(json.error?.message ?? "Failed to load activity");
            }
            return json.data;
        },
        refetchInterval: 15000,
    });

    const rows = data?.rows ?? [];
    const s = data?.summary;

    return (
        <div className="max-w-6xl mx-auto py-8 px-6 min-h-screen bg-gray-50">
            <Link
                href="/leads/neodove-campaigns"
                className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800"
            >
                <ArrowLeft className="w-4 h-4" /> NeoDove
            </Link>

            <h1 className="mt-3 text-2xl font-bold text-gray-900 tracking-tight">
                Sync activity
            </h1>
            <p className="text-sm text-gray-500 mt-1">
                Every lead we pushed and every event NeoDove sent back.
            </p>

            {s && (
                <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <Stat label="Pushed (24h)" value={s.outbound} />
                    <Stat label="Received (24h)" value={s.inbound} />
                    <Stat
                        label="Errors (24h)"
                        value={s.errors}
                        tone={s.errors > 0 ? "text-rose-600" : "text-gray-900"}
                    />
                    {/* Backfilled is the drift signal: anything here arrived by
                        CSV because a webhook never did. */}
                    <Stat
                        label="Backfilled (24h)"
                        value={s.backfilled}
                        tone={s.backfilled > 0 ? "text-amber-600" : "text-gray-900"}
                    />
                </div>
            )}

            {s && s.inbound === 0 && s.outbound > 0 && (
                <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex gap-2">
                    <Info className="w-4 h-4 mt-0.5 shrink-0" />
                    <span>
                        Leads are going out but nothing is coming back. If the inbound
                        webhook has not been configured in NeoDove (Workflows → Send
                        Webhook), no call outcome will ever reach this system and every
                        disposition will have to be recovered by CSV reconciliation.
                    </span>
                </div>
            )}

            <div className="mt-5 flex items-center gap-2">
                {(["all", "outbound", "inbound"] as Filter[]).map((f) => (
                    <button
                        key={f}
                        onClick={() => {
                            setFilter(f);
                            setPage(1);
                        }}
                        className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                            filter === f
                                ? "bg-gray-900 text-white"
                                : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
                        }`}
                    >
                        {f === "all" ? "All" : f === "outbound" ? "Sent" : "Received"}
                    </button>
                ))}
                <label className="ml-2 inline-flex items-center gap-1.5 text-sm text-gray-700">
                    <input
                        type="checkbox"
                        checked={errorsOnly}
                        onChange={(e) => {
                            setErrorsOnly(e.target.checked);
                            setPage(1);
                        }}
                        className="rounded border-gray-300"
                    />
                    Errors only
                </label>
            </div>

            {isLoading && (
                <p className="mt-6 text-sm text-gray-500">Loading activity…</p>
            )}

            {isError && (
                <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
                    <p className="text-sm text-rose-700">
                        {error instanceof Error ? error.message : "Failed to load."}
                    </p>
                    <p className="mt-1 text-xs text-rose-600">
                        If this mentions a missing relation, run{" "}
                        <code className="font-mono">node scripts/apply-e224.mjs</code>.
                    </p>
                </div>
            )}

            {!isLoading && !isError && rows.length === 0 && (
                <div className="mt-6 rounded-xl border border-dashed border-gray-300 bg-white px-6 py-14 text-center">
                    <p className="text-sm text-gray-600 font-medium">
                        Nothing here yet
                    </p>
                    <p className="text-xs text-gray-500 mt-1.5">
                        Activity appears once a campaign pushes leads, or NeoDove sends
                        its first webhook.
                    </p>
                </div>
            )}

            {rows.length > 0 && (
                <div className="mt-5 overflow-hidden rounded-xl border border-gray-200 bg-white">
                    <table className="w-full text-sm">
                        <thead className="bg-gray-50 text-gray-600 text-xs uppercase tracking-wider">
                            <tr>
                                <th className="px-4 py-3 text-left font-semibold">
                                    When
                                </th>
                                <th className="px-4 py-3 text-left font-semibold">
                                    Direction
                                </th>
                                <th className="px-4 py-3 text-left font-semibold">
                                    Event
                                </th>
                                <th className="px-4 py-3 text-left font-semibold">
                                    Lead
                                </th>
                                <th className="px-4 py-3 text-left font-semibold">
                                    Campaign
                                </th>
                                <th className="px-4 py-3 text-left font-semibold">
                                    Result
                                </th>
                                <th className="px-4 py-3 text-left font-semibold">
                                    Payload
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((r) => {
                                const outbound = r.direction === "outbound";
                                const open = openRows.has(r.id);
                                const hasPayload =
                                    r.request_payload != null ||
                                    r.response_payload != null;
                                return (
                                    <Fragment key={r.id}>
                                    <tr
                                        className={`border-t border-gray-100 ${
                                            r.error ? "bg-rose-50/40" : ""
                                        }`}
                                    >
                                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                                            {new Date(r.created_at).toLocaleString(
                                                "en-IN",
                                                {
                                                    day: "2-digit",
                                                    month: "short",
                                                    hour: "2-digit",
                                                    minute: "2-digit",
                                                },
                                            )}
                                        </td>
                                        <td className="px-4 py-3">
                                            <span
                                                className={`inline-flex items-center gap-1 text-xs font-medium ${
                                                    outbound
                                                        ? "text-blue-700"
                                                        : "text-purple-700"
                                                }`}
                                            >
                                                {outbound ? (
                                                    <ArrowUpRight className="w-3.5 h-3.5" />
                                                ) : (
                                                    <ArrowDownLeft className="w-3.5 h-3.5" />
                                                )}
                                                {outbound ? "Sent" : "Received"}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3 text-gray-700 text-xs">
                                            {r.event_type ?? "—"}
                                        </td>
                                        <td className="px-4 py-3 text-gray-700 text-xs">
                                            {r.dealer_name || r.dealer_lead_id || "—"}
                                            {r.phone && (
                                                <span className="text-gray-400">
                                                    {" "}
                                                    · {r.phone}
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-xs">
                                            {r.neodove_campaign_id ? (
                                                <Link
                                                    href={`/leads/neodove-campaigns/${r.neodove_campaign_id}`}
                                                    className="text-gray-700 hover:text-emerald-700 hover:underline"
                                                >
                                                    {r.campaign_name ??
                                                        r.neodove_campaign_id}
                                                </Link>
                                            ) : (
                                                <span className="text-gray-400">—</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-xs">
                                            {r.error ? (
                                                <span
                                                    className="inline-flex items-start gap-1 text-rose-700"
                                                    title={r.error}
                                                >
                                                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                                    <span className="line-clamp-2">
                                                        {r.error}
                                                    </span>
                                                </span>
                                            ) : (
                                                <span className="text-gray-600">
                                                    {r.http_status
                                                        ? `HTTP ${r.http_status}`
                                                        : "OK"}
                                                    {r.attempts > 1 &&
                                                        ` · ${r.attempts} attempts`}
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-xs">
                                            {hasPayload ? (
                                                <button
                                                    onClick={() => toggleRow(r.id)}
                                                    className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50"
                                                >
                                                    <Code2 className="w-3.5 h-3.5" />
                                                    {open ? "Hide" : "View"}
                                                </button>
                                            ) : (
                                                <span className="text-gray-400">—</span>
                                            )}
                                        </td>
                                    </tr>

                                    {open && (
                                        <tr className="border-t border-gray-100 bg-gray-50/60">
                                            <td colSpan={7} className="px-4 py-3">
                                                <div className="grid gap-3 md:grid-cols-2">
                                                    <PayloadBlock
                                                        title={
                                                            outbound
                                                                ? "What we sent"
                                                                : "What NeoDove sent (verbatim)"
                                                        }
                                                        value={r.request_payload}
                                                    />
                                                    <PayloadBlock
                                                        title={
                                                            outbound
                                                                ? "NeoDove's reply"
                                                                : "Our reply"
                                                        }
                                                        value={r.response_payload}
                                                    />
                                                </div>
                                                {!outbound && (
                                                    <p className="mt-2 text-[11px] text-gray-500">
                                                        This is the payload{" "}
                                                        <code>parseInboundEvent()</code> has
                                                        to understand. If fields are landing
                                                        empty on the lead, the key names here
                                                        are the answer — record them in{" "}
                                                        <code>docs/neodove-contract.md</code>
                                                        .
                                                    </p>
                                                )}
                                            </td>
                                        </tr>
                                    )}
                                    </Fragment>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}

            {rows.length > 0 && (
                <div className="mt-4 flex items-center justify-between">
                    <button
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        disabled={page === 1}
                        className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-gray-50"
                    >
                        Previous
                    </button>
                    <span className="text-sm text-gray-600">Page {page}</span>
                    <button
                        onClick={() => setPage((p) => p + 1)}
                        disabled={rows.length < 50}
                        className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm disabled:opacity-50 hover:bg-gray-50"
                    >
                        Next
                    </button>
                </div>
            )}
        </div>
    );
}

function Stat({
    label,
    value,
    tone = "text-gray-900",
}: {
    label: string;
    value: number;
    tone?: string;
}) {
    return (
        <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
            <p className="text-[11px] uppercase tracking-wide text-gray-500">
                {label}
            </p>
            <p className={`mt-0.5 text-xl font-bold tabular-nums ${tone}`}>{value}</p>
        </div>
    );
}
