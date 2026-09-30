// WhatsApp contact counts only with a screenshot (tracker ID 79, handover
// P2-7, 29 Sep 2026). One writer for the CRM's Log Touchpoint and the WhatsApp
// Assistant's log_call.
//
//   "Dealer replied" + a screenshot → contact: the lead moves to Under
//      discussion when it is earlier than that, and it counts as work on the
//      idle clock.
//   Anything else (no screenshot, or no reply) → a plain note: no status, no
//      idle clock.
//   A screenshot whose bytes (sha256) were already used on any touchpoint is
//      REUSED: saved and shown, flagged on the Sales Head view, never counted.
//
// Screenshots are shown on the lead timeline (the attachment) and on the Sales
// Head view (listWhatsappScreenshots). Runs on the caller's transaction.

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { writeTouchpoint } from "@/lib/touchpoints/write";
import { isForward } from "@/lib/lifecycle/statusRules";
import type { LeadStatus } from "@/lib/lifecycle/transitions";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function screenshotHash(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

export type WhatsappContactResult = {
    touchpointId: string;
    countedAsContact: boolean;
    reused: boolean;
    statusTo: LeadStatus | null;
};

export async function recordWhatsappContact(
    tx: Tx,
    input: {
        leadId: string;
        actorId: string;
        remarks: string;
        dealerReplied: boolean;
        screenshot: { url: string; sha256: string } | null;
    },
): Promise<WhatsappContactResult> {
    const { screenshot } = input;
    let reused = false;
    if (screenshot) {
        const seen = (await tx.execute<{ n: number }>(sql`
            SELECT COUNT(*)::int AS n FROM lead_touchpoints WHERE screenshot_sha256 = ${screenshot.sha256}
        `)) as unknown as Array<{ n: number }>;
        reused = (seen[0]?.n ?? 0) > 0;
    }
    const counts = input.dealerReplied && !!screenshot && !reused;

    const rows = (await tx.execute<{ lead_status: string | null }>(sql`
        SELECT lead_status FROM dealer_leads WHERE id = ${input.leadId} LIMIT 1
    `)) as unknown as Array<{ lead_status: string | null }>;
    const from = rows[0]?.lead_status ?? null;
    // Awaiting field visit ends only with a visit (ID 77).
    const statusTo: LeadStatus | null =
        counts && from !== "Transferred_to_ASM" && isForward(from, "Under_Discussion") ? "Under_Discussion" : null;

    const prefix = counts
        ? "WhatsApp — dealer replied (screenshot)"
        : reused
          ? "WhatsApp — screenshot REUSED from another entry, not counted"
          : screenshot
            ? "WhatsApp — screenshot, no reply from the dealer"
            : "WhatsApp note (no screenshot — not counted as contact)";

    const r = await writeTouchpoint(
        {
            dealerLeadId: input.leadId,
            touchpointType: "whatsapp",
            performedBy: input.actorId,
            remarks: `${prefix}: ${input.remarks}`,
            attachments: screenshot ? [{ url: screenshot.url, type: "whatsapp_screenshot", reused }] : [],
            isEngaged: counts,
            countsAsWork: counts,
            statusChange: statusTo ? { from: from as LeadStatus | null, to: statusTo, event: "progress" } : undefined,
        },
        { tx },
    );

    if (screenshot) {
        await tx.execute(sql`
            UPDATE lead_touchpoints SET screenshot_sha256 = ${screenshot.sha256}
             WHERE touchpoint_id = ${r.touchpointId}::uuid
        `);
    }
    return { touchpointId: r.touchpointId, countedAsContact: counts, reused, statusTo };
}

/** Sales Head view: recent WhatsApp screenshots, reused ones flagged. */
export async function listWhatsappScreenshots(days = 7) {
    return (await db.execute<{
        touchpoint_id: string;
        dealer_lead_id: string;
        dealer_name: string | null;
        performed_by_name: string | null;
        performed_at: string;
        url: string | null;
        reused: boolean;
    }>(sql`
        SELECT t.touchpoint_id, t.dealer_lead_id,
               COALESCE(dl.dealer_name, dl.shop_name) AS dealer_name,
               u.name AS performed_by_name, t.performed_at::text AS performed_at,
               t.attachments -> 0 ->> 'url' AS url,
               COALESCE((t.attachments -> 0 ->> 'reused')::boolean, false) AS reused
          FROM lead_touchpoints t
          JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
          LEFT JOIN users u ON u.id::text = t.performed_by
         WHERE t.touchpoint_type = 'whatsapp'
           AND t.screenshot_sha256 IS NOT NULL
           AND t.performed_at >= NOW() - make_interval(days => ${days})
         ORDER BY reused DESC, t.performed_at DESC
         LIMIT 200
    `)) as unknown as Array<{
        touchpoint_id: string;
        dealer_lead_id: string;
        dealer_name: string | null;
        performed_by_name: string | null;
        performed_at: string;
        url: string | null;
        reused: boolean;
    }>;
}
