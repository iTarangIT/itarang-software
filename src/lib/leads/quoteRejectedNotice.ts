// ID 135 — tell the lead owner the CEO rejected their quote, with his reason,
// on the web (bell) and on WhatsApp.
//
// Before this the rep got an alert when the CEO approved (notifyQuotationApproved)
// and nothing when he rejected — only a timeline note — so a refused discount
// went unanswered and the dealer went quiet.
//
// WhatsApp goes through getAdapter(), so WA_DRY_RUN=1 logs instead of sending,
// exactly like every other out-of-band send. The number is the owner's linked
// Sales Assistant WhatsApp when they have one (verified), else users.phone.
// It is a free-form text: Meta refuses it when the rep has not messaged the
// number in the last 24 hours, which is logged and never fails the decision.
//
// Everything here is best-effort and never throws: the CEO's decision is
// already committed when this runs.

import { sql } from "drizzle-orm";

export type QuoteRejectedNoticeInput = {
    dealerName: string | null;
    quoteNumber: string | null;
    versionNo: number;
    value: number;
    reason: string;
    rejectorName?: string | null;
    /** Where the lead was left — decides the "what now" line. */
    leadMove: "back" | "pre_transfer" | "stay";
    /** The approved version the dealer can still answer, when one is left. */
    liveVersionNo: number | null;
};

/** The one sentence the bell and WhatsApp both carry. Pure. */
export function quoteRejectedMessage(p: QuoteRejectedNoticeInput): string {
    const dealer = p.dealerName?.trim() || "the dealer";
    const ref = p.quoteNumber ? ` ${p.quoteNumber}` : "";
    const money = p.value > 0 ? ` (₹${p.value.toLocaleString("en-IN")})` : "";
    const who = p.rejectorName?.trim() || "The CEO";
    const next =
        p.liveVersionNo != null
            ? `v${p.liveVersionNo} is still the live quote with the dealer.`
            : p.leadMove === "back"
              ? "No quote is left with the dealer, so the lead is back at Under discussion. Raise a revised quote or follow up."
              : p.leadMove === "pre_transfer"
                ? "No quote is left with the dealer; after the field visit the lead returns to Under discussion. Raise a revised quote or follow up."
                : "No quote is left with the dealer. Raise a revised quote or follow up.";
    return `${who} rejected quotation v${p.versionNo}${ref}${money} for ${dealer}. Reason: ${p.reason.trim()}. ${next}`;
}

/** users.phone is free text; Meta wants digits with the country code. Pure. */
export function ownerWhatsAppNumber(raw: string | null | undefined): string | null {
    const digits = (raw ?? "").replace(/\D/g, "");
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 12 && digits.startsWith("91")) return digits;
    if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
    return digits.length >= 11 ? digits : null;
}

/**
 * Bell + WhatsApp to the lead owner. Never throws. Lazy imports keep the
 * WhatsApp stack out of the route's cold path and keep the pure helpers above
 * importable from a unit test with no database.
 */
export async function alertOwnerQuoteRejected(p: {
    leadId: string;
    commercialId: string;
    ownerUserId: string | null;
    notice: QuoteRejectedNoticeInput;
}): Promise<void> {
    if (!p.ownerUserId) return;
    const message = quoteRejectedMessage(p.notice);

    try {
        const { notifyQuotationRejected } = await import("@/lib/notifications/events");
        await notifyQuotationRejected({
            leadId: p.leadId,
            commercialId: p.commercialId,
            ownerUserId: p.ownerUserId,
            dealerName: p.notice.dealerName,
            quoteNumber: p.notice.quoteNumber,
            versionNo: p.notice.versionNo,
            value: p.notice.value,
            reason: p.notice.reason,
            rejectorName: p.notice.rejectorName,
            message,
        });
    } catch (err) {
        console.error("[quoteRejectedNotice] bell failed", { leadId: p.leadId, err });
    }

    try {
        const { db } = await import("@/lib/db");
        const rows = (await db.execute<{ phone: string | null }>(sql`
            SELECT COALESCE(
                     (SELECT b.wa_phone FROM assistant_wa_bindings b
                       WHERE b.user_id = u.id AND b.status = 'active' AND b.wa_phone IS NOT NULL
                       LIMIT 1),
                     u.phone) AS phone
              FROM users u
             WHERE u.id = ${p.ownerUserId}
             LIMIT 1
        `)) as unknown as Array<{ phone: string | null }>;
        const to = ownerWhatsAppNumber(rows[0]?.phone);
        if (!to) {
            console.log(`[quoteRejectedNotice] owner ${p.ownerUserId} has no WhatsApp number; bell only`);
            return;
        }
        const { getAdapter } = await import("@/lib/whatsapp");
        const { logOutbound } = await import("@/lib/whatsapp/notifications");
        const body = `❌ *Quotation rejected*\n\n${message}`;
        const res = await getAdapter().sendText(to, body);
        await logOutbound(null, res, { messageType: "text", textBody: body });
        if (!res.ok) {
            console.warn(`[quoteRejectedNotice] WhatsApp to owner not delivered: ${res.error ?? "unknown"}`);
        }
    } catch (err) {
        console.error("[quoteRejectedNotice] WhatsApp failed", { leadId: p.leadId, err });
    }
}
