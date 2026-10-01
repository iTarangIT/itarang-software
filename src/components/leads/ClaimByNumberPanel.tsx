"use client";

// Claim by mobile number (tracker IDs 45 / 46, handover P0-2). Replaces the
// unowned-pool tabs for ISRs and ASMs: type one number, or several separated by
// commas, and only the leads with those numbers are shown, each with Claim.
// An ASM sees when a lead is outside their territory — the claim is still
// allowed and is flagged for the Sales Head.

import { useState } from "react";
import { Search, UserPlus2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ClaimLeadConfirm } from "@/components/leads/ClaimLeadConfirm";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

type Row = {
    id: string;
    dealer_name: string | null;
    shop_name: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    lead_status: string | null;
    owner_name: string | null;
    owned_by_me: boolean;
    claimable: boolean;
    in_territory: boolean | null;
};

type Result = { rows: Row[]; not_found: string[]; invalid: string[] };

export function ClaimByNumberPanel({ onClaimed }: { onClaimed?: () => void }) {
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [result, setResult] = useState<Result | null>(null);
    const [target, setTarget] = useState<Row | null>(null);

    const search = async (e?: React.FormEvent) => {
        e?.preventDefault();
        if (!input.trim()) return;
        setLoading(true);
        setError(null);
        try {
            const res = await fetch(`/api/leads/claim-search?mobiles=${encodeURIComponent(input)}`, {
                cache: "no-store",
            });
            const json = await res.json();
            if (!res.ok) throw new Error(json?.error?.message ?? "Search failed");
            setResult(json.data as Result);
        } catch (err) {
            setResult(null);
            setError((err as Error).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
            <div>
                <h3 className="text-sm font-semibold text-gray-900">Find a lead to claim</h3>
                <p className="text-xs text-gray-500">
                    Search by mobile number — one, or several separated by commas. Only matching leads are shown.
                </p>
            </div>
            <form onSubmit={search} className="flex gap-2">
                <Input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="e.g. 9876543210, 9123456789"
                    inputMode="tel"
                    className="flex-1"
                />
                <Button type="submit" disabled={loading || !input.trim()}>
                    <Search className="mr-1.5 h-4 w-4" />
                    {loading ? "Searching…" : "Search"}
                </Button>
            </form>

            {error && <p className="text-sm text-red-600">{error}</p>}

            {result && (
                <div className="space-y-2">
                    {result.rows.length === 0 && (
                        <p className="text-sm text-gray-500">No lead has that number.</p>
                    )}
                    <ul className="divide-y divide-gray-100 rounded-lg border border-gray-100">
                        {result.rows.map((r) => (
                            <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
                                <div className="min-w-0">
                                    <p className="truncate text-sm font-medium text-gray-900">
                                        {r.dealer_name || r.shop_name || "Unnamed lead"}
                                    </p>
                                    <p className="text-xs text-gray-500">
                                        {r.phone} · {[r.city, r.state].filter(Boolean).join(", ") || "No location"} ·{" "}
                                        {r.lead_status ? (LEAD_STATUS_LABEL[r.lead_status as LeadStatus] ?? r.lead_status) : "No status"}
                                    </p>
                                    {r.in_territory === false && r.claimable && (
                                        <p className="mt-0.5 text-xs font-medium text-amber-700">
                                            Outside your territory — you can still claim it; the Sales Head will see it.
                                        </p>
                                    )}
                                </div>
                                {r.claimable ? (
                                    <Button size="sm" onClick={() => setTarget(r)}>
                                        <UserPlus2 className="mr-1.5 h-4 w-4" />
                                        Claim
                                    </Button>
                                ) : (
                                    <span className="text-xs text-gray-500">
                                        {r.owned_by_me
                                            ? "Already yours"
                                            : r.owner_name
                                              ? `Owned by ${r.owner_name}`
                                              : "Closed — not claimable"}
                                    </span>
                                )}
                            </li>
                        ))}
                    </ul>
                    {result.not_found.length > 0 && (
                        <p className="text-xs text-gray-500">No lead for: {result.not_found.join(", ")}</p>
                    )}
                    {result.invalid.length > 0 && (
                        <p className="text-xs text-red-600">Not a valid mobile: {result.invalid.join(", ")}</p>
                    )}
                </div>
            )}

            {target && (
                <ClaimLeadConfirm
                    open
                    onClose={() => setTarget(null)}
                    leadId={target.id}
                    dealerName={target.dealer_name || target.shop_name || "this lead"}
                    onSuccess={() => {
                        setTarget(null);
                        void search();
                        onClaimed?.();
                    }}
                />
            )}
        </div>
    );
}
