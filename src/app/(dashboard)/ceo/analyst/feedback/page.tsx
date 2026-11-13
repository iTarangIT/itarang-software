// /ceo/analyst/feedback — the AI Analyst answer-feedback review queue (E-380).
// Every thumbs up / down the CEO or Sales Head gave an answer, thumbs-down first. Each row
// carries a snapshot of the question and answer, because a thread only opens for its owner.

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { FeedbackReviewRow } from "@/components/analyst/FeedbackReviewRow";
import { requireRole } from "@/lib/auth-utils";
import { hasFeedbackTable, listFeedback, queueCounts, type QueueFilter } from "@/lib/analyst/feedbackStore";

export const dynamic = "force-dynamic";
export const metadata = { title: "AI Analyst feedback" };

const FILTERS: { key: QueueFilter; label: string }[] = [
    { key: "new", label: "To review" },
    { key: "reviewed", label: "Reviewed" },
    { key: "all", label: "All" },
];

export default async function AnalystFeedbackPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const me = await requireRole(["ceo", "admin"]);
    const { show } = await searchParams;
    const filter: QueueFilter = show === "reviewed" || show === "all" ? show : "new";

    const ready = await hasFeedbackTable();
    const [rows, counts] = ready
        ? await Promise.all([listFeedback(filter), queueCounts()])
        : [[], { new_down: 0, new_up: 0, reviewed: 0 }];

    return (
        <div className="space-y-6 pb-12">
            <div>
                <Link href="/ceo/analyst" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-sky hover:underline">
                    <ArrowLeft className="h-3.5 w-3.5" /> AI Analyst
                </Link>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-brand-navy">AI Analyst answer feedback</h1>
                <p className="mt-1 text-sm text-ink-muted">
                    Answers people rated. Wrong answers come first. Check each one, fix the rule or the data behind it,
                    then mark it reviewed.
                </p>
            </div>

            {!ready ? (
                <p className="max-w-3xl rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                    Feedback is not set up on this server yet. Migration E-380 has to be applied first.
                </p>
            ) : (
                <div className="max-w-3xl space-y-4">
                    <div className="flex flex-wrap items-center gap-2">
                        {FILTERS.map((f) => (
                            <Link
                                key={f.key}
                                href={f.key === "new" ? "/ceo/analyst/feedback" : `/ceo/analyst/feedback?show=${f.key}`}
                                aria-current={f.key === filter ? "page" : undefined}
                                className={
                                    f.key === filter
                                        ? "rounded-full bg-brand-navy px-3 py-1 text-xs font-semibold text-white"
                                        : "rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50"
                                }
                            >
                                {f.label}
                            </Link>
                        ))}
                        <span className="text-xs text-gray-500">
                            {counts.new_down} wrong answer{counts.new_down === 1 ? "" : "s"} to review · {counts.new_up} good ·{" "}
                            {counts.reviewed} reviewed
                        </span>
                    </div>

                    {rows.length === 0 ? (
                        <p className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">
                            {filter === "new" ? "Nothing to review. Every rated answer has been checked." : "No feedback here yet."}
                        </p>
                    ) : (
                        rows.map((r) => <FeedbackReviewRow key={r.id} row={r} ownerView={r.user_id === me.id} />)
                    )}
                </div>
            )}
        </div>
    );
}
