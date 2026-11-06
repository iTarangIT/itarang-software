import { ChevronRight } from "lucide-react";
import { Suspense } from "react";

import { requireRole } from "@/lib/auth-utils";
import { TargetsView } from "./TargetsView";

export const dynamic = "force-dynamic";

// R-17 — the sales target register (sheet 8, Requirement #15; item 3 workflow).
// TargetsView reads ?month= (the notification links carry it), hence Suspense.
export default async function TargetsPage() {
    await requireRole(["ceo", "admin", "sales_head", "business_head"]);

    return (
        <div className="px-4 sm:px-6 md:px-8 py-6 space-y-5 max-w-[1500px]">
            <header>
                <h1 className="text-2xl font-semibold tracking-tight text-ink">Targets</h1>
                {/* C14 (wording audit, 2 Nov): one line; the full rules sit under "How targets work". */}
                <p className="mt-1 text-sm text-ink-muted">
                    Set each person&apos;s monthly targets and post them to the Sales Head.
                </p>
                <details className="group mt-1 max-w-3xl text-sm">
                    <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-semibold text-brand-sky hover:underline [&::-webkit-details-marker]:hidden">
                        How targets work
                        <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                    </summary>
                    <p className="mt-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs leading-relaxed text-ink-muted">
                        {"The CEO enters each person's targets (drafts nobody else sees) and presses Post to Sales Head. Only the CEO adds a person or a metric, and only the CEO removes a target he set; a removed target keeps its history, and the person is told if it had reached them. The Sales Head (or Admin) may add a stretch on top of the CEO target, with a note (CEO 100 + 50 = 150; a stretch never reduces it), then presses Approve & push. The person is told by notification and email and accepts, or asks for a correction, on their performance page. Not accepted within 48 hours of the first push and the daily Targets Pending mail says so; asking for a correction does not stop that clock. A change after posting is a new version: the CEO posts it, the Sales Head pushes it, and until then the last version stays in force. History lists every version. Progress is measured pro-rata by working day (Mon–Sat, minus holidays) from the 1st of the month; a custom metric's progress is entered by hand."}
                    </p>
                </details>
            </header>
            <Suspense fallback={null}>
                <TargetsView />
            </Suspense>
        </div>
    );
}
