/**
 * Tracker ID 5 — sends the reorder reminders planned in ./reorderReminderPlan.ts:
 * the daily Orange nudge, the monthly Dormant win-back list and the CEO's
 * "turned Dormant" alert.
 *
 * Runs from an hourly ticker (instrumentation-node.ts) as the job
 * "dealer-reorder-reminders", so off the live CRM the mailer drops the sends
 * (src/lib/runtime/liveSite.ts). Nothing goes out before REMINDER_HOUR_IST.
 *
 * ONCE PER PERIOD. Each mail claims its account_reminder_log row (E-334) with
 * INSERT … ON CONFLICT DO NOTHING before sending, and deletes the row if the
 * send fails, so the next tick retries it. A restart, a second process or an
 * hourly re-run never mails twice. Without E-334 nothing is sent.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email/mailer";
import { appUrl } from "@/lib/email/sendDigestEmail";
import { listDealerHealth, type DealerHealthRow } from "@/lib/dealers/accountHealth";
import { hasOrderClaimTables } from "./tables";
import {
    ceoRecipients,
    dormancyKey,
    istMonth,
    newlyDormant,
    planOrangeNudges,
    planWinback,
    REMINDER_HOUR_IST,
    type ReminderMail,
    type ReminderUser,
} from "./reorderReminderPlan";

export type ReorderReminderResult = {
    skipped?: string;
    orange: number;
    winback: number;
    ceoAlerted: number;
    errors: string[];
};

type Kind = "orange_daily" | "dormant_winback" | "dormant_ceo";

async function claim(kind: Kind, period: string, recipient: string, dealers: number): Promise<boolean> {
    const rows = (await db.execute(sql`
        INSERT INTO account_reminder_log (kind, period_key, recipient, dealers)
        VALUES (${kind}, ${period}, ${recipient}, ${dealers})
        ON CONFLICT DO NOTHING
        RETURNING 1 AS ok
    `)) as unknown as unknown[];
    return rows.length > 0;
}

async function release(kind: Kind, period: string, recipient: string): Promise<void> {
    await db.execute(sql`
        DELETE FROM account_reminder_log
         WHERE kind = ${kind} AND period_key = ${period} AND recipient = ${recipient}
    `);
}

const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const dmy = (iso: string | null) =>
    iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—";

/** One plain HTML table that reflows on a phone. */
function dealerTable(rows: DealerHealthRow[], withOwner: boolean): string {
    const th = (t: string, right = false) =>
        `<th style="text-align:${right ? "right" : "left"};padding:6px 8px;border-bottom:1px solid #ddd;font-size:12px;color:#555">${t}</th>`;
    const td = (t: string, right = false) =>
        `<td style="text-align:${right ? "right" : "left"};padding:6px 8px;border-bottom:1px solid #eee;font-size:13px">${t}</td>`;
    const head = [
        th("Dealer"),
        th("City"),
        ...(withOwner ? [th("Owner")] : []),
        th("Last invoice"),
        th("Days since", true),
        th("Usual gap (d)", true),
        th("Lifetime", true),
    ].join("");
    const body = rows
        .map((r) =>
            `<tr>${[
                td(esc(r.dealer)),
                td(esc(r.city ?? "—")),
                ...(withOwner ? [td(esc(r.owner_name ?? "No owner"))] : []),
                td(dmy(r.last_order)),
                td(String(r.days_since_last_order ?? "—"), true),
                td(r.avg_reorder_days == null ? "—" : String(r.avg_reorder_days), true),
                td(rupees(r.revenue_lifetime), true),
            ].join("")}</tr>`,
        )
        .join("");
    return `<table style="border-collapse:collapse;width:100%;max-width:760px">${`<tr>${head}</tr>`}${body}</table>`;
}

function mailHtml(args: { greeting: string; intro: string; table: string; ctaHref: string; ctaLabel: string; footer: string }): string {
    return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1a1a1a;max-width:760px">
<p style="font-size:14px">${esc(args.greeting)}</p>
<p style="font-size:14px">${args.intro}</p>
${args.table}
<p style="margin:20px 0"><a href="${esc(args.ctaHref)}" style="background:#0f62fe;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px">${esc(args.ctaLabel)}</a></p>
<p style="font-size:12px;color:#666">${args.footer}</p>
</div>`;
}

const textList = (rows: DealerHealthRow[]) =>
    rows
        .map((r) => `- ${r.dealer}${r.city ? ` (${r.city})` : ""}: last invoice ${dmy(r.last_order)}, ${r.days_since_last_order ?? "—"} days`)
        .join("\n");

const FOOTER =
    "Sent by the iTarang CRM. Got an order that has no invoice yet? Press “Order placed” on My dealers — " +
    "the reminders stop while accounts raise the invoice. A dealer that has shut or moved on can be closed on Dealer Health.";

async function sendMail(
    kind: Kind,
    period: string,
    mail: ReminderMail,
    build: (m: ReminderMail) => { subject: string; html: string; text: string },
    errors: string[],
): Promise<boolean> {
    if (!(await claim(kind, period, mail.recipientId, mail.dealers.length))) return false;
    try {
        const m = build(mail);
        await sendEmail({ to: mail.email, subject: m.subject, html: m.html, text: m.text });
        return true;
    } catch (e) {
        await release(kind, period, mail.recipientId).catch(() => undefined);
        errors.push(`${kind} → ${mail.email}: ${e instanceof Error ? e.message : String(e)}`);
        return false;
    }
}

function istNow(now: Date): { day: string; hour: number } {
    const ist = new Date(now.getTime() + 330 * 60_000);
    return { day: ist.toISOString().slice(0, 10), hour: ist.getUTCHours() };
}

export async function runReorderReminders(now = new Date()): Promise<ReorderReminderResult> {
    const result: ReorderReminderResult = { orange: 0, winback: 0, ceoAlerted: 0, errors: [] };
    const { day, hour } = istNow(now);
    if (hour < REMINDER_HOUR_IST) return { ...result, skipped: `before ${REMINDER_HOUR_IST}:00 IST` };
    if (!(await hasOrderClaimTables())) return { ...result, skipped: "E-334 not applied" };

    const [rows, users] = await Promise.all([
        listDealerHealth(),
        db.execute(sql`SELECT id::text AS id, email, name, role, is_active FROM users`) as unknown as Promise<ReminderUser[]>,
    ]);
    const base = appUrl();
    const ownerLink = `${base}/my-dealers`;
    const healthLink = (bucket: string) => `${base}/admin/reports/dealer-health?bucket=${bucket}`;

    // 1 · Orange — every day, to the owner.
    for (const mail of planOrangeNudges(rows, users)) {
        const sent = await sendMail("orange_daily", day, mail, (m) => {
            const n = m.dealers.length;
            const intro =
                `${n} of ${m.includesUnowned ? "these" : "your"} dealer${n === 1 ? " is" : "s are"} in the <b>Orange zone</b>: ` +
                `31–45 days since the last invoice — the right time to pitch the next order.` +
                (m.includesUnowned ? " Dealers marked “No owner” need one assigned." : "");
            return {
                subject: `Orange zone: ${n} dealer${n === 1 ? "" : "s"} to pitch today`,
                html: mailHtml({
                    greeting: `Hi ${m.name ?? "there"},`,
                    intro,
                    table: dealerTable(m.dealers, m.includesUnowned),
                    ctaHref: m.includesUnowned ? healthLink("orange") : ownerLink,
                    ctaLabel: m.includesUnowned ? "Open Dealer Health" : "Open My dealers",
                    footer: FOOTER,
                }),
                text: `Orange zone — ${n} dealer(s) to pitch today (31–45 days since the last invoice):\n${textList(m.dealers)}\n\n${ownerLink}`,
            };
        }, result.errors);
        if (sent) result.orange += 1;
    }

    // 2 · Dormant win-back — once a month, from the 1st.
    const month = istMonth(day);
    for (const mail of planWinback(rows, users)) {
        const sent = await sendMail("dormant_winback", month, mail, (m) => {
            const n = m.dealers.length;
            const whole = m.dealers.length > 0 && m.dealers.some((d) => d.owner_id !== m.recipientId);
            return {
                subject: `Win-back list: ${n} dormant dealer${n === 1 ? "" : "s"} (${month})`,
                html: mailHtml({
                    greeting: `Hi ${m.name ?? "there"},`,
                    intro:
                        `This month's <b>win-back list</b>: ${n} dealer${n === 1 ? " has" : "s have"} not been invoiced for more than 60 days. ` +
                        `Call them, or close the ones that have shut or moved to another supplier.`,
                    table: dealerTable(m.dealers, whole),
                    ctaHref: whole ? healthLink("dormant") : ownerLink,
                    ctaLabel: whole ? "Open Dealer Health" : "Open My dealers",
                    footer: FOOTER,
                }),
                text: `Win-back list ${month} — ${n} dormant dealer(s):\n${textList(m.dealers)}\n\n${whole ? healthLink("dormant") : ownerLink}`,
            };
        }, result.errors);
        if (sent) result.winback += 1;
    }

    // 3 · CEO — when a dealer turns Dormant (once per dormancy).
    const ceos = ceoRecipients(users);
    const dormant = rows.filter((r) => r.bucket === "dormant");
    if (ceos.length > 0 && dormant.length > 0) {
        const keys = dormant.map(dormancyKey);
        const known = (await db.execute(sql`
            SELECT period_key FROM account_reminder_log
             WHERE kind = 'dormant_ceo' AND recipient = 'ceo' AND period_key IN ${keys}
        `)) as unknown as Array<{ period_key: string }>;
        const fresh = newlyDormant(rows, new Set(known.map((k) => k.period_key)));
        // Claim each dealer; only the ones this run claimed are mailed.
        const claimed: DealerHealthRow[] = [];
        for (const r of fresh) {
            if (await claim("dormant_ceo", dormancyKey(r), "ceo", 1)) claimed.push(r);
        }
        if (claimed.length > 0) {
            const n = claimed.length;
            const total = dormant.length;
            const lifetime = claimed.reduce((s, r) => s + r.revenue_lifetime, 0);
            try {
                await sendEmail({
                    to: ceos.map((c) => c.email),
                    subject: `${n} dealer${n === 1 ? "" : "s"} turned Dormant`,
                    html: mailHtml({
                        greeting: "Hi,",
                        intro:
                            `${n} dealer${n === 1 ? " has" : "s have"} gone more than 60 days without an invoice ` +
                            `(lifetime ${rupees(lifetime)}). ${total} dealer${total === 1 ? " is" : "s are"} Dormant in all.`,
                        table: dealerTable(claimed, true),
                        ctaHref: healthLink("dormant"),
                        ctaLabel: "Open Dealer Health",
                        footer: "Sent by the iTarang CRM once per dealer each time it turns Dormant.",
                    }),
                    text: `${n} dealer(s) turned Dormant (${total} Dormant in all):\n${textList(claimed)}\n\n${healthLink("dormant")}`,
                });
                result.ceoAlerted = n;
            } catch (e) {
                for (const r of claimed) await release("dormant_ceo", dormancyKey(r), "ceo").catch(() => undefined);
                result.errors.push(`dormant_ceo: ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }
    return result;
}
