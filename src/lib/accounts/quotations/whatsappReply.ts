/**
 * E-358 — an account answering its quotation from the WhatsApp buttons
 * (`aquote_approve:<id>` / `aquote_decline:<id>`). The account twin of
 * src/lib/whatsapp/quotationReply.ts, with the same rule: the button id is not
 * authority — the quotation must have been SENT over WhatsApp to this number
 * (account_quotation_dispatches). Returns true when it owned the message.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getAdapter } from "@/lib/whatsapp";
import type { InboundEvent } from "@/lib/whatsapp/types";
import { recordAccountDealerDecision } from "./decision";
import { ACCOUNT_QUOTE_APPROVE_PREFIX, ACCOUNT_QUOTE_DECLINE_PREFIX } from "./send";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseAccountQuotationButton(
    text: string | null | undefined,
): { quotationId: string; decision: "approved" | "declined" } | null {
    const raw = (text ?? "").trim();
    const [prefix, decision] = raw.startsWith(ACCOUNT_QUOTE_APPROVE_PREFIX)
        ? [ACCOUNT_QUOTE_APPROVE_PREFIX, "approved" as const]
        : raw.startsWith(ACCOUNT_QUOTE_DECLINE_PREFIX)
          ? [ACCOUNT_QUOTE_DECLINE_PREFIX, "declined" as const]
          : [null, null];
    if (!prefix) return null;
    const quotationId = raw.slice(prefix.length).trim();
    return UUID_RE.test(quotationId) ? { quotationId, decision } : null;
}

const last10 = (p: string) => p.replace(/\D/g, "").slice(-10);

async function wasSentToThisNumber(quotationId: string, waPhone: string): Promise<boolean> {
    try {
        const rows = (await db.execute(sql`
            SELECT recipient FROM account_quotation_dispatches
             WHERE quotation_id = ${quotationId}::uuid AND channel = 'whatsapp' AND status = 'sent'
             ORDER BY created_at DESC LIMIT 20
        `)) as unknown as Array<{ recipient: string }>;
        const me = last10(waPhone);
        return me.length === 10 && rows.some((r) => last10(r.recipient) === me);
    } catch (e) {
        // Fail closed: an unverifiable sender is not an authorised one.
        console.error("[accountQuote/whatsappReply] dispatch lookup failed", e);
        return false;
    }
}

async function say(to: string, body: string) {
    try {
        await getAdapter().sendText(to, body);
    } catch (e) {
        console.error("[accountQuote/whatsappReply] acknowledgement failed", e);
    }
}

export async function handleAccountQuotationReply(event: InboundEvent): Promise<boolean> {
    const press = parseAccountQuotationButton(event.text);
    if (!press) return false;
    if (!(await wasSentToThisNumber(press.quotationId, event.waPhone))) {
        await say(
            event.waPhone,
            "Sorry, we couldn't match that response to a quotation sent to this number. Please contact your iTarang representative.",
        );
        return true;
    }
    const r = await recordAccountDealerDecision({
        quotationId: press.quotationId,
        decision: press.decision,
        via: "whatsapp",
        actor: event.waPhone,
    });
    const ref = r.outcome === "recorded" || r.outcome === "already_answered" ? (r.quoteNumber ?? "") : "";
    await say(
        event.waPhone,
        r.outcome === "recorded"
            ? r.decision === "approved"
                ? `Thank you — your approval of quotation ${ref} is recorded. Your iTarang representative will be in touch.`
                : `Thank you — we've recorded that quotation ${ref} isn't right for you. Your iTarang representative will follow up.`
            : r.outcome === "already_answered"
              ? `You've already responded to quotation ${ref} (${r.decision}). Nothing further is needed.`
              : r.outcome === "not_open"
                ? r.reason
                : "Sorry, we couldn't find that quotation. Please contact your iTarang representative.",
    );
    return true;
}
