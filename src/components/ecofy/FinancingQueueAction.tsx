"use client";

// Per-row actions on the Financing queue (/sales-head/ecofy/financing).
//
// The queue row IS an OpenAPI `Case` (GET /financing-queue → data: Case[]), so
// the lead screen's own FinancingDecisionForm is reused as-is: it posts
// `financing_decision` through /api/ecofy/leads/[id]/actions, which re-checks
// access.ts (Sales Head / CEO only, stage S6) and sends If-Match = case
// version. FR-11.5: iTarang Admin records the decision for OTHER financiers;
// Ecofy enforces "role per financier" and refuses an Ecofy-financed File.
//
// A case that never reached the CRM (no ecofy_leads row) has no CRM lead to
// post against — the row offers only "Open in Ecofy".

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { canDoEcofyAction } from "@/lib/ecofy/access";
import type { EcofyCase } from "./client";
import { FinancingDecisionForm } from "./tabs/LaterStageTabs";
import { Btn } from "./ui";

export function FinancingQueueAction({
    leadId,
    leadHref,
    c,
    viewer,
}: {
    leadId: string | null;
    /** The lead page opened on its Financing tab. */
    leadHref: string | null;
    c: EcofyCase;
    viewer: { id: string; role: string };
}) {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    // Same gate as the lead's Financing tab (manager, stage S6).
    const canDecide = canDoEcofyAction(viewer, { assigned_to_user_id: null, stage: c.stage }, "financing_decision");

    if (!leadId || !leadHref) {
        return <span className="text-xs text-gray-500">Not in the CRM — decide in Ecofy</span>;
    }

    return (
        <div className="flex min-w-[220px] flex-col items-end gap-2 text-left">
            <div className="flex flex-wrap justify-end gap-2">
                <Link
                    href={leadHref}
                    className="inline-flex items-center rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50"
                >
                    Open Financing tab
                </Link>
                {!open && canDecide && (
                    <Btn variant="primary" onClick={() => setOpen(true)}>
                        Record decision
                    </Btn>
                )}
            </div>
            {open && canDecide && (
                <div className="w-full min-w-[320px] rounded-lg border border-gray-200 bg-gray-50 p-3">
                    <p className="mb-2 text-xs text-gray-600">
                        Other financiers only — Ecofy records the decision on its own financing.
                    </p>
                    <FinancingDecisionForm
                        leadId={leadId}
                        c={c}
                        viewer={viewer}
                        assignedTo={null}
                        onDone={() => {
                            setOpen(false);
                            router.refresh();
                        }}
                    />
                    <div className="mt-2 flex justify-end">
                        <Btn onClick={() => setOpen(false)}>Cancel</Btn>
                    </div>
                </div>
            )}
        </div>
    );
}
