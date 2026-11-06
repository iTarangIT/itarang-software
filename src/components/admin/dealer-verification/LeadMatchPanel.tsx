"use client";

// Tracker ID 214 (decided 2 Nov, Kartik) — Dealer Validation > Lead.
// Every onboarding sits on exactly one lead. This shows the lead it was put on
// (name, owner, status), how it was matched and who gets the credit, and lets
// Admin Confirm / Change lead / Not the same dealer / Change credit owner.
// Approval waits for Confirm (the server enforces it too).

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Link2, Loader2 } from "lucide-react";

type Panel = {
    enabled: boolean;
    lead: { id: string; name: string | null; status: string | null; owner_id: string | null; owner_name: string | null } | null;
    method: string | null;
    method_label: string | null;
    credit: { id: string | null; name: string | null };
    confirmed_at: string | null;
    confirmed_by_name: string | null;
    candidates: Array<{ id: string; name: string | null; city: string | null; status: string | null }>;
    people: Array<{ id: string; name: string; role: string }>;
};

const pretty = (s: string | null | undefined) => (s ? s.replace(/_/g, " ") : "—");

export function LeadMatchPanel({
    dealerId,
    readOnly,
    onBlockedChange,
}: {
    dealerId: string;
    readOnly?: boolean;
    /** true while approval must wait for the lead to be confirmed. */
    onBlockedChange?: (blocked: boolean) => void;
}) {
    const [data, setData] = useState<Panel | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [leadId, setLeadId] = useState("");
    const [creditId, setCreditId] = useState<string>("");

    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/admin/dealer-verifications/${encodeURIComponent(dealerId)}/lead-match`, { cache: "no-store" });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.message ?? "Could not load the lead.");
            setData(json.data);
            setCreditId(json.data.credit.id ?? "");
        } catch (e) {
            setError((e as Error).message);
        }
    }, [dealerId]);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(() => {
        if (!data) return;
        onBlockedChange?.(data.enabled && !data.confirmed_at);
    }, [data, onBlockedChange]);

    const act = async (body: Record<string, unknown>) => {
        setBusy(true);
        setError(null);
        try {
            const res = await fetch(`/api/admin/dealer-verifications/${encodeURIComponent(dealerId)}/lead-match`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.message ?? "Could not save.");
            setData(json.data);
            setCreditId(json.data.credit.id ?? "");
            setLeadId("");
        } catch (e) {
            setError((e as Error).message);
        } finally {
            setBusy(false);
        }
    };

    if (data && !data.enabled) return null;

    return (
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center gap-3">
                <div className="rounded-2xl bg-slate-50 p-3 text-slate-700">
                    <Link2 className="h-5 w-5" />
                </div>
                <div>
                    <h3 className="text-lg font-semibold text-slate-900">Lead</h3>
                    <p className="mt-1 text-sm text-slate-500">The lead this onboarding is on, and who gets the credit. Confirm before approving.</p>
                </div>
            </div>

            {!data && !error && (
                <div className="mt-4 flex items-center gap-2 text-sm text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
            )}
            {error && <p className="mt-4 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

            {data && (
                <div className="mt-4 space-y-4 text-sm">
                    {data.lead ? (
                        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                            <div>
                                <dt className="text-xs text-slate-500">Lead</dt>
                                <dd className="font-medium text-slate-900">
                                    <Link href={`/leads/${data.lead.id}`} className="text-sky-700 hover:underline">
                                        {data.lead.name ?? data.lead.id}
                                    </Link>
                                </dd>
                            </div>
                            <div>
                                <dt className="text-xs text-slate-500">Owner</dt>
                                <dd className="text-slate-900">{data.lead.owner_name ?? "No owner"}</dd>
                            </div>
                            <div>
                                <dt className="text-xs text-slate-500">Status</dt>
                                <dd className="text-slate-900">{pretty(data.lead.status)}</dd>
                            </div>
                            <div>
                                <dt className="text-xs text-slate-500">How matched</dt>
                                <dd className="text-slate-900">{data.method_label ?? "—"}</dd>
                            </div>
                            <div>
                                <dt className="text-xs text-slate-500">Credit to</dt>
                                <dd className="text-slate-900">{data.credit.name ?? "Nobody (no credit)"}</dd>
                            </div>
                            <div>
                                <dt className="text-xs text-slate-500">Confirmed</dt>
                                <dd className={data.confirmed_at ? "text-emerald-700" : "text-amber-700"}>
                                    {data.confirmed_at
                                        ? `Yes${data.confirmed_by_name ? `, by ${data.confirmed_by_name}` : ""}`
                                        : "Not yet — approval waits for this"}
                                </dd>
                            </div>
                        </dl>
                    ) : (
                        <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
                            Not on a lead yet.
                            {data.candidates.length > 0
                                ? " Possible lead below: pick it, or press 'Not the same dealer' to create one."
                                : " Press 'Find again', or 'Not the same dealer' to create a Direct onboarding lead."}
                        </p>
                    )}

                    {data.candidates.length > 0 && (
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Possible lead</p>
                            <ul className="mt-1 divide-y divide-slate-100 rounded-xl border border-slate-200">
                                {data.candidates.map((c) => (
                                    <li key={c.id} className="flex items-center justify-between gap-3 px-3 py-2">
                                        <span>
                                            <Link href={`/leads/${c.id}`} className="text-sky-700 hover:underline">
                                                {c.name ?? c.id}
                                            </Link>
                                            <span className="text-slate-500"> · {c.city ?? "—"} · {pretty(c.status)}</span>
                                        </span>
                                        {!readOnly && (
                                            <button
                                                type="button"
                                                disabled={busy}
                                                onClick={() => void act({ action: "change_lead", leadId: c.id })}
                                                className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-semibold hover:bg-slate-50"
                                            >
                                                Use this lead
                                            </button>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    {!readOnly && (
                        <div className="space-y-3 border-t border-slate-100 pt-4">
                            <div className="flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    disabled={busy || !data.lead || !!data.confirmed_at}
                                    onClick={() => void act({ action: "confirm" })}
                                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                                >
                                    Confirm
                                </button>
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => {
                                        if (window.confirm("Not the same dealer? The lead is released and a new Direct onboarding lead is created for this dealer.")) {
                                            void act({ action: "not_same_dealer" });
                                        }
                                    }}
                                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50"
                                >
                                    Not the same dealer
                                </button>
                                <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void act({ action: "find_again" })}
                                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50"
                                >
                                    Find again
                                </button>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <input
                                    value={leadId}
                                    onChange={(e) => setLeadId(e.target.value)}
                                    placeholder="Lead ID (DL-…)"
                                    className="w-56 rounded-lg border border-slate-200 px-2 py-1.5 text-xs"
                                    aria-label="Lead ID to use"
                                />
                                <button
                                    type="button"
                                    disabled={busy || !leadId.trim()}
                                    onClick={() => void act({ action: "change_lead", leadId: leadId.trim() })}
                                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50"
                                >
                                    Change lead
                                </button>
                            </div>
                            {data.lead && (
                                <div className="flex flex-wrap items-center gap-2">
                                    <select
                                        value={creditId}
                                        onChange={(e) => setCreditId(e.target.value)}
                                        className="w-56 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs"
                                        aria-label="Credit owner"
                                    >
                                        <option value="">Nobody (no credit)</option>
                                        {data.people.map((p) => (
                                            <option key={p.id} value={p.id}>
                                                {p.name} · {pretty(p.role)}
                                            </option>
                                        ))}
                                    </select>
                                    <button
                                        type="button"
                                        disabled={busy || creditId === (data.credit.id ?? "")}
                                        onClick={() => void act({ action: "change_credit", userId: creditId || null })}
                                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50"
                                    >
                                        Change credit owner
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}
