"use client";

// The file's KYC action log — who did what, and when — from
// GET /api/kyc/[leadId]/timeline (lib/kyc/kycEventLog). Shown on the CRM KYC
// review page and the dealer's KYC page. Collapsed by default; renders nothing
// when the API refuses the viewer or the file has no lines yet.

import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, History, RefreshCw } from "lucide-react";

interface Row {
    at: string;
    line: string;
    byName: string | null;
    byRole: string | null;
    kind: "kyc" | "final_decision";
}

const ROLE_LABEL: Record<string, string> = {
    admin: "Admin",
    sales_head: "Sales Head",
    dealer: "Dealer",
    ceo: "CEO",
    business_head: "Business Head",
    system: "System",
};

const fmt = (iso: string) =>
    new Date(iso).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "Asia/Kolkata",
    });

function who(r: Row): string {
    const role = r.byRole ? (ROLE_LABEL[r.byRole.toLowerCase()] ?? r.byRole.replace(/_/g, " ")) : null;
    if (!r.byName && (!role || role === "System")) return "iTarang (automatic)";
    return [r.byName ?? "Someone", role ? `(${role})` : null].filter(Boolean).join(" ");
}

export default function KycTimeline({ leadId, defaultOpen = false }: { leadId: string; defaultOpen?: boolean }) {
    const [rows, setRows] = useState<Row[] | null>(null);
    const [open, setOpen] = useState(defaultOpen);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/kyc/${encodeURIComponent(leadId)}/timeline`, { cache: "no-store" });
            const json = await res.json().catch(() => null);
            setRows(res.ok && json?.success ? (json.data.rows as Row[]) : []);
        } catch {
            setRows([]);
        } finally {
            setLoading(false);
        }
    }, [leadId]);

    useEffect(() => {
        void load();
    }, [load]);

    if (!rows || rows.length === 0) return null;

    return (
        <section className="mb-4 rounded-xl border border-gray-200 bg-white">
            <div className="flex items-center justify-between px-4 py-3">
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    className="flex items-center gap-2 text-sm font-semibold text-gray-900"
                    aria-expanded={open}
                >
                    {open ? <ChevronDown className="h-4 w-4 text-gray-400" /> : <ChevronRight className="h-4 w-4 text-gray-400" />}
                    <History className="h-4 w-4 text-gray-500" />
                    KYC history
                    <span className="font-normal text-gray-500">
                        · {rows.length} action{rows.length === 1 ? "" : "s"} · last {fmt(rows[0].at)}
                    </span>
                </button>
                {open && (
                    <button
                        type="button"
                        onClick={() => void load()}
                        className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-800"
                        disabled={loading}
                    >
                        <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} /> Refresh
                    </button>
                )}
            </div>
            {open && (
                <ol className="max-h-96 divide-y divide-gray-100 overflow-y-auto border-t border-gray-100">
                    {rows.map((r, i) => (
                        <li key={`${r.at}:${i}`} className="grid grid-cols-1 gap-1 px-4 py-2.5 text-sm sm:grid-cols-[11rem_1fr_14rem]">
                            <span className="whitespace-nowrap text-xs tabular-nums text-gray-500 sm:text-sm">{fmt(r.at)}</span>
                            <span className={r.kind === "final_decision" ? "font-semibold text-gray-900" : "text-gray-800"}>{r.line}</span>
                            <span className="text-xs text-gray-600 sm:text-right sm:text-sm">{who(r)}</span>
                        </li>
                    ))}
                </ol>
            )}
        </section>
    );
}
