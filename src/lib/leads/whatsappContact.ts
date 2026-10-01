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
// Head view (/admin/whatsapp-screenshots, listWhatsappScreenshots). Runs on the
// caller's transaction.
//
// The generic touchpoint API cannot do what this does: a "whatsapp" touchpoint
// logged there never moves the status (planTouchpoint drops its status
// change), so a chat reaches Under discussion only through here, with a
// screenshot.

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

/**
 * Has this exact image already been used on a touchpoint? The same check
 * recordWhatsappContact makes when it writes — exported so the WhatsApp
 * Assistant can say so on its preview instead of after Confirm.
 */
export async function screenshotAlreadyUsed(sha256: string, executor: Pick<typeof db, "execute"> = db): Promise<boolean> {
    const seen = (await executor.execute<{ n: number }>(sql`
        SELECT COUNT(*)::int AS n FROM lead_touchpoints WHERE screenshot_sha256 = ${sha256}
    `)) as unknown as Array<{ n: number }>;
    return (seen[0]?.n ?? 0) > 0;
}

/**
 * Does a WhatsApp entry count as contact? Only "dealer replied" with a fresh
 * screenshot. Pure — the one rule for the writer and for any preview of it.
 */
export function whatsappCounts(input: { dealerReplied: boolean; hasScreenshot: boolean; reused: boolean }): boolean {
    return input.dealerReplied && input.hasScreenshot && !input.reused;
}

export async function recordWhatsappContact(
    tx: Tx,
    input: {
        leadId: string;
        actorId: string;
        remarks: string;
        dealerReplied: boolean;
        screenshot: { url: string; sha256: string } | null;
        /** A follow-up agreed in the chat — recorded on the touchpoint as its next action. */
        nextActionAt?: Date | null;
    },
): Promise<WhatsappContactResult> {
    const { screenshot } = input;
    const reused = screenshot ? await screenshotAlreadyUsed(screenshot.sha256, tx) : false;
    const counts = whatsappCounts({ dealerReplied: input.dealerReplied, hasScreenshot: !!screenshot, reused });

    // Read under the row lock the writer takes anyway: a call or a quote event
    // that lifts the lead to Under discussion at the same moment must be seen
    // here, or this entry would ask for a move the guard then refuses — and
    // the whole entry, screenshot included, would roll back.
    const rows = (await tx.execute<{ lead_status: string | null }>(sql`
        SELECT lead_status FROM dealer_leads WHERE id = ${input.leadId} LIMIT 1 FOR UPDATE
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
            remarks: input.remarks.trim() ? `${prefix}: ${input.remarks.trim()}` : prefix,
            attachments: screenshot ? [{ url: screenshot.url, type: "whatsapp_screenshot", reused }] : [],
            isEngaged: counts,
            countsAsWork: counts,
            nextAction: input.nextActionAt ? "follow_up" : null,
            nextActionAt: input.nextActionAt ?? null,
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

export type WhatsappScreenshotRow = {
    touchpoint_id: string;
    dealer_lead_id: string;
    dealer_name: string | null;
    city: string | null;
    performed_by_name: string | null;
    performed_at: string;
    url: string | null;
    remarks: string | null;
    /** Counted as contact (dealer replied + a fresh screenshot). */
    counted: boolean;
    reused: boolean;
    /** For a reused image: the earlier entry that used it first. */
    first_used_by_name: string | null;
    first_used_dealer_name: string | null;
    first_used_at: string | null;
};

/** The view's cap; the page says so when it is reached. */
export const WHATSAPP_SCREENSHOT_LIMIT = 200;

/**
 * Sales Head view: recent WhatsApp screenshots, reused ones first and flagged,
 * each with the entry that used the image before it.
 */
export async function listWhatsappScreenshots(days = 7): Promise<WhatsappScreenshotRow[]> {
    return (await db.execute<WhatsappScreenshotRow>(sql`
        SELECT t.touchpoint_id::text AS touchpoint_id, t.dealer_lead_id,
               COALESCE(dl.dealer_name, dl.shop_name) AS dealer_name,
               dl.city,
               u.name AS performed_by_name, t.performed_at::text AS performed_at,
               t.attachments -> 0 ->> 'url' AS url,
               t.remarks,
               COALESCE(t.is_engaged, false) AS counted,
               COALESCE((t.attachments -> 0 ->> 'reused')::boolean, false) AS reused,
               f.by_name AS first_used_by_name,
               f.dealer_name AS first_used_dealer_name,
               f.performed_at AS first_used_at
          FROM lead_touchpoints t
          JOIN dealer_leads dl ON dl.id = t.dealer_lead_id
          LEFT JOIN users u ON u.id::text = t.performed_by
          -- The EARLIER entry that carries the same image, if any.
          LEFT JOIN LATERAL (
            SELECT fu.name AS by_name,
                   COALESCE(fl.dealer_name, fl.shop_name) AS dealer_name,
                   ft.performed_at::text AS performed_at
              FROM lead_touchpoints ft
              JOIN dealer_leads fl ON fl.id = ft.dealer_lead_id
              LEFT JOIN users fu ON fu.id::text = ft.performed_by
             WHERE ft.screenshot_sha256 = t.screenshot_sha256
               AND ft.touchpoint_id <> t.touchpoint_id
               AND ft.performed_at <= t.performed_at
             ORDER BY ft.performed_at ASC
             LIMIT 1
          ) f ON TRUE
         WHERE t.touchpoint_type = 'whatsapp'
           AND t.screenshot_sha256 IS NOT NULL
           AND t.performed_at >= NOW() - make_interval(days => ${days})
         ORDER BY reused DESC, t.performed_at DESC
         LIMIT ${WHATSAPP_SCREENSHOT_LIMIT}
    `)) as unknown as WhatsappScreenshotRow[];
}
