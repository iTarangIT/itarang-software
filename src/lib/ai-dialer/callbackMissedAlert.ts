// ID 212 (decided 4 Nov, Kartik) — a callback still not made 30 minutes after
// the agreed time also goes on WhatsApp to the Sales Head and the ISR's
// manager, so someone senior hears of it in time ("callbacks are missed only
// when people forget"). The bell and email to the Sales Head and the owner are
// unchanged (callbackLoop.ts).
//
// Sent from the callback loop's ticker, which runs as the scheduled job
// "callback-loop": off the live CRM the WhatsApp adapter drops it (ID 125).
// Template `callback_missed` once Meta approves it (WA_TEMPLATES_APPROVED);
// until then free text, which reaches only a number with an open 24-hour
// window — the same as the KYC staff alerts. Never throws.

import { sql } from "drizzle-orm";

import { ownerWhatsAppNumber } from "@/lib/leads/quoteRejectedNotice";

export type MissedCallback = {
    lead_id: string;
    name: string | null;
    phone?: string | null;
    due_at: string | Date;
    assigned_user_id: string | null;
    owner_name: string | null;
};

type Person = { user_id: string; phone: string | null };

/** "4 Nov, 4:00 pm" in IST. Pure. */
export function istDue(at: string | Date): string {
    return new Date(at).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
    });
}

/** The WhatsApp text. Pure. */
export function missedCallbackMessage(cb: MissedCallback, appUrl: string): string {
    const dealer = cb.name ?? cb.lead_id;
    return (
        `⏰ *Callback missed*\n\n` +
        `${dealer}${cb.phone ? ` (${cb.phone})` : ""}: the callback agreed for ${istDue(cb.due_at)} ` +
        `has no call 30 minutes later.\n` +
        `Owner: ${cb.owner_name ?? "not set"}\n\n` +
        `${appUrl.replace(/\/+$/, "")}/leads?lead=${encodeURIComponent(cb.lead_id)}`
    );
}

/**
 * Who gets it: every active Sales Head and the owner's current manager — not
 * the owner (who has the bell and email), each number once. Pure.
 */
export function missedCallbackRecipients(salesHeads: Person[], manager: Person | null, ownerId: string | null): string[] {
    const out = new Set<string>();
    for (const p of [...salesHeads, ...(manager ? [manager] : [])]) {
        if (ownerId && p.user_id === ownerId) continue;
        const n = ownerWhatsAppNumber(p.phone);
        if (n) out.add(n);
    }
    return [...out];
}

/** ID 212 fallback: the missed callback as a bell + email to the owner's manager. Never throws. */
async function bellAndEmailManager(cb: MissedCallback, managerId: string): Promise<void> {
    try {
        const { emit } = await import("@/lib/notifications/emit");
        await emit({
            // The same type as the loop's overdue alert, so the bell and email settings match.
            type: "lead.callback_overdue",
            title: `Callback missed: ${cb.name ?? "a promised callback"}`,
            message: `${cb.name ?? cb.lead_id}: the callback agreed for ${istDue(cb.due_at)} has no call 30 minutes later (owner: ${cb.owner_name ?? "not set"}).`,
            leadId: cb.lead_id,
            stage: "AI callback",
            to: [
                {
                    audience: { kind: "user", userId: managerId },
                    as: { party: "admin", label: "Manager" },
                    href: `/leads?lead=${encodeURIComponent(cb.lead_id)}`,
                },
            ],
            email: true,
        });
    } catch (err) {
        console.warn("[callback-missed] manager bell/email failed:", err instanceof Error ? err.message : err);
    }
}

const PHONE = sql`COALESCE(
    (SELECT b.wa_phone FROM assistant_wa_bindings b
      WHERE b.user_id = u.id AND b.status = 'active' AND b.wa_phone IS NOT NULL LIMIT 1),
    u.phone)`;

/**
 * WhatsApp the Sales Heads and the owner's manager about a missed callback. Never throws.
 * `fallbackBellEmail` (ID 212, settings › AI callbacks): while the template is not approved,
 * the manager also gets the alert as a bell + email (the Sales Head already has both from
 * the loop), because plain WhatsApp text rarely reaches them.
 */
export async function alertMissedCallbackWhatsApp(cb: MissedCallback, opts: { fallbackBellEmail?: boolean } = {}): Promise<number> {
    try {
        const { db } = await import("@/lib/db");
        const salesHeads = (await db.execute(sql`
            SELECT u.id::text AS user_id, ${PHONE} AS phone
              FROM users u
             WHERE u.is_active IS NOT FALSE AND lower(u.role) = 'sales_head'
        `)) as unknown as Person[];
        let manager: Person | null = null;
        if (cb.assigned_user_id) {
            const { currentTeamOf } = await import("@/lib/users/team");
            const managerId = (await currentTeamOf()).get(cb.assigned_user_id) ?? null;
            if (managerId) {
                const [m] = (await db.execute(sql`
                    SELECT u.id::text AS user_id, ${PHONE} AS phone
                      FROM users u WHERE u.id::text = ${managerId} AND u.is_active IS NOT FALSE LIMIT 1
                `)) as unknown as Person[];
                manager = m ?? null;
            }
        }
        // ID 212 fallback first: it must reach the manager even when nobody has a WhatsApp number.
        if (opts.fallbackBellEmail && manager && manager.user_id !== cb.assigned_user_id) {
            const { resolveTemplate: tplOf } = await import("@/lib/whatsapp/templates");
            if (!tplOf("callback_missed")) await bellAndEmailManager(cb, manager.user_id);
        }
        const to = missedCallbackRecipients(salesHeads, manager, cb.assigned_user_id);
        if (to.length === 0) return 0;

        const appUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "https://crm.itarang.com";
        const body = missedCallbackMessage(cb, appUrl);
        const { getAdapter } = await import("@/lib/whatsapp");
        const { logOutbound } = await import("@/lib/whatsapp/notifications");
        const { resolveTemplate } = await import("@/lib/whatsapp/templates");
        const { oneLine } = await import("@/lib/whatsapp/window");
        const tpl = resolveTemplate("callback_missed");
        const params = [cb.name ?? cb.lead_id, istDue(cb.due_at), cb.owner_name ?? "not set"].map((p) => oneLine(p));
        const adapter = getAdapter();
        let sent = 0;
        await Promise.all(
            to.map(async (phone) => {
                const res = tpl ? await adapter.sendTemplate(phone, tpl.name, tpl.lang, params) : await adapter.sendText(phone, body);
                await logOutbound(
                    null,
                    res,
                    tpl
                        ? { messageType: "template", textBody: params.join(" | "), templateName: tpl.name }
                        : { messageType: "text", textBody: body },
                );
                if (res.ok) sent++;
                else console.warn(`[callback-missed] WhatsApp to ${phone.slice(-4)} not delivered: ${res.error ?? "unknown"}`);
            }),
        );
        return sent;
    } catch (err) {
        console.warn("[callback-missed] WhatsApp alert failed:", err instanceof Error ? err.message : err);
        return 0;
    }
}
