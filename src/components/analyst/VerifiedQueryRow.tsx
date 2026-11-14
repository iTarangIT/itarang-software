"use client";

// One verified query on /ceo/analyst/verified, with Unverify (E-382).

import { BadgeCheck } from "lucide-react";
import { useState } from "react";

import { formatWhen } from "@/lib/analyst/when";

type Row = {
    id: string;
    question: string;
    sql: string;
    verified_by_name: string | null;
    verified_at: string;
    note: string | null;
};

export function VerifiedQueryRow({ row }: { row: Row }) {
    const [gone, setGone] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function unverify() {
        setBusy(true);
        setError(null);
        try {
            const response = await fetch(`/api/analyst/verified?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
            if (!response.ok) throw new Error("failed");
            setGone(true);
        } catch {
            setError("Could not remove it. Try again.");
        } finally {
            setBusy(false);
        }
    }

    if (gone) {
        return (
            <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500">
                Verification removed for &ldquo;{row.question}&rdquo;.
            </p>
        );
    }

    return (
        <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <p className="flex items-start gap-1.5 text-sm font-semibold break-words text-ink">
                        <BadgeCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
                        {row.question}
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                        Verified by {row.verified_by_name ?? "someone"} · {formatWhen(row.verified_at)}
                    </p>
                    {row.note ? <p className="mt-1 text-xs text-gray-600">{row.note}</p> : null}
                </div>
                <button
                    type="button"
                    disabled={busy}
                    onClick={() => void unverify()}
                    className="shrink-0 rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                >
                    Unverify
                </button>
            </div>
            <pre className="overflow-x-auto rounded-lg bg-brand-navy p-3 font-mono text-[0.75rem] whitespace-pre-wrap text-white/90">
                {row.sql}
            </pre>
            {error ? <p className="text-xs text-danger">{error}</p> : null}
        </div>
    );
}
