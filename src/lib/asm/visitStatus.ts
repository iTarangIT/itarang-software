// The status a DONE visit leaves the lead in (tracker ID 77, handover P2-5,
// 29 Sep 2026). One writer for the visit route, the WhatsApp Assistant's
// log_visit and "Visit not needed".
//
//   Awaiting field visit (Transferred_to_ASM) ends ONLY here: the lead goes to
//   the further of what the ASM chose and where it was before the transfer
//   (pre_transfer_status), and never below Under_Discussion — a lead transferred
//   at Commercials finalised no longer drops back to Under discussion.
//   Any other lead moves forward to what the ASM chose, if anything.
//
// Runs on the caller's transaction; the S3 guard in writeTouchpoint still
// applies (event "visit").

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { isForward, STATUS_RANK } from "@/lib/lifecycle/statusRules";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const RESTORABLE = new Set<string>([
    "Under_Discussion",
    "Commercials_Explained",
    "Awaiting_Customer_Decision",
    "Commercials_Finalised",
]);

/** Pure: the status a done visit moves the lead to, or null for "leave it". */
export function statusAfterVisit(input: {
    current: string | null;
    preTransfer: string | null;
    requested: LeadStatus | null;
}): LeadStatus | null {
    const { current, preTransfer, requested } = input;
    if (current === "Transferred_to_ASM") {
        const candidates: LeadStatus[] = ["Under_Discussion"];
        if (preTransfer && RESTORABLE.has(preTransfer)) candidates.push(preTransfer as LeadStatus);
        // ID 75 / 80: the ASM can ask for first contact only; commercials
        // stages come from quote events (the pre-transfer stage is restored).
        if (requested === "Under_Discussion") candidates.push(requested);
        return candidates.reduce((a, b) => ((STATUS_RANK[b] ?? 0) > (STATUS_RANK[a] ?? 0) ? b : a));
    }
    if (requested === "Under_Discussion" && isForward(current, requested)) return requested;
    return null;
}

export async function applyVisitStatus(
    tx: Tx,
    input: { leadId: string; actorId: string; requested: LeadStatus | null; remarks: string },
): Promise<{ historyId: string | null; status: LeadStatus | null }> {
    const rows = (await tx.execute<{ lead_status: string | null; pre_transfer_status: string | null }>(sql`
        SELECT lead_status, pre_transfer_status FROM dealer_leads WHERE id = ${input.leadId} LIMIT 1
    `)) as unknown as Array<{ lead_status: string | null; pre_transfer_status: string | null }>;
    const lead = rows[0];
    if (!lead) return { historyId: null, status: null };
    const to = statusAfterVisit({
        current: lead.lead_status,
        preTransfer: lead.pre_transfer_status,
        requested: input.requested,
    });
    if (!to) return { historyId: null, status: null };
    const r = await writeTouchpoint(
        {
            dealerLeadId: input.leadId,
            touchpointType: "status_change_note",
            performedBy: input.actorId,
            remarks: input.remarks,
            statusChange: { from: lead.lead_status as LeadStatus | null, to, event: "visit" },
        },
        { tx },
    );
    return { historyId: r.historyId, status: to };
}
