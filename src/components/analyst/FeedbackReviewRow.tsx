"use client";

// One row of the AI Analyst answer-feedback review queue (/ceo/analyst/feedback, E-380).

import { ThumbsDown, ThumbsUp } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { FeedbackRow } from "@/lib/analyst/feedbackStore";
import { formatWhen } from "@/lib/analyst/when";

export function FeedbackReviewRow({ row, ownerView }: { row: FeedbackRow; ownerView: boolean }) {
    const router = useRouter();
    const [note, setNote] = useState(row.review_note ?? "");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const down = row.rating === "down";
    const who = row.user_name
        ? `${row.user_name}${row.user_role ? ` (${row.user_role.replace(/_/g, " ")})` : ""}`
        : "Unknown user";

    async function save(status: "reviewed" | "new") {
        setError(null);
        try {
            const response = await fetch("/api/analyst/feedback", {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ id: row.id, status, note: note.trim() || null }),
            });
            if (!response.ok) {
                const body = (await response.json().catch(() => null)) as { error?: string } | null;
                throw new Error(body?.error ?? "could not save");
            }
            startTransition(() => router.refresh());
        } catch (e) {
            setError(e instanceof Error ? e.message : "could not save");
        }
    }

    return (
        <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <span
                        className={
                            down
                                ? "inline-flex items-center gap-1 rounded-md bg-red-50 px-2 py-1 text-xs font-semibold text-red-700"
                                : "inline-flex items-center gap-1 rounded-md bg-green-50 px-2 py-1 text-xs font-semibold text-green-700"
                        }
                    >
                        {down ? <ThumbsDown className="h-3.5 w-3.5" /> : <ThumbsUp className="h-3.5 w-3.5" />}
                        {down ? "Wrong / unhelpful" : "Good answer"}
                    </span>
                    <span className="truncate text-xs text-gray-500">
                        {who} · {formatWhen(row.updated_at)}
                    </span>
                </div>
                {row.status === "reviewed" ? (
                    <span className="text-xs font-semibold text-green-700">
                        Reviewed{row.reviewed_by_name ? ` by ${row.reviewed_by_name}` : ""}
                        {row.reviewed_at ? `, ${formatWhen(row.reviewed_at)}` : ""}
                    </span>
                ) : (
                    <span className="text-xs font-semibold text-amber-700">To review</span>
                )}
            </div>

            <div className="space-y-2 text-sm">
                <p>
                    <span className="text-gray-500">Asked: </span>
                    <span className="font-medium text-gray-900">{row.question ?? "(not recorded)"}</span>
                </p>
                <div className="rounded-md bg-gray-50 px-3 py-2 text-gray-800 whitespace-pre-wrap">
                    {row.answer ?? "(no answer recorded)"}
                </div>
                {row.comment ? (
                    <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        <span className="font-semibold">What was wrong:</span> {row.comment}
                    </p>
                ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
                <input
                    value={note}
                    maxLength={1000}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="Review note, e.g. rule fixed, data corrected"
                    className="min-w-0 flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs"
                />
                {row.status === "reviewed" ? (
                    <button
                        type="button"
                        disabled={pending}
                        onClick={() => void save("new")}
                        className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                    >
                        Reopen
                    </button>
                ) : (
                    <button
                        type="button"
                        disabled={pending}
                        onClick={() => void save("reviewed")}
                        className="rounded-lg bg-brand-navy px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                    >
                        Mark reviewed
                    </button>
                )}
                {ownerView ? (
                    <Link
                        href={`/ceo/analyst?thread=${encodeURIComponent(row.thread_id)}`}
                        className="text-xs font-semibold text-brand-sky hover:underline"
                    >
                        Open conversation
                    </Link>
                ) : null}
            </div>
            {error ? <p className="text-xs text-red-600">{error}</p> : null}
        </div>
    );
}
