/**
 * Tracker ID 204 — sending the EMI messages. Server only.
 *
 *   runEmiMessages()      the daily job (in-process ticker, instrumentation-node):
 *                         ages the EMIs first (runEmiAging — it never ran on the
 *                         PM2 boxes), then sends the scheduled messages due today
 *                         for the PILOT lender's unpaid EMIs, each once per EMI.
 *   queueEmiReceived()    "received Rs X, next EMI due <date>" after a recorded
 *                         payment (portal, Excel upload, auto-debit, webhook).
 *   sendPortalReminder()  the lender portal's "Send payment reminder", for real.
 *   sendEmiTestMessages() Admin > Settings > EMI messages > test send.
 *
 * Every send is claimed first (./store.ts) and goes on WhatsApp (a Meta
 * template) and SMS (an MSG91 Flow template) with the APPROVED text only.
 * Nothing is sent while the settings are off, without a pilot lender, or
 * before E-365. Rules: ./rules.ts.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
    EMI_CHANNELS,
    EMI_MESSAGE_KINDS,
    dueKindsFor,
    fillText,
    fmtAmount,
    fmtDay,
    mobile10,
    templateParams,
    type EmiChannel,
    type EmiFieldValues,
    type EmiMessageConfig,
    type EmiMessageKind,
    type EmiMessagesSettings,
} from "./rules";
import { getEmiMessagesSettings } from "./settings";
import { claimEmiMessage, finishEmiMessage, hasEmiMessages, type EmiMessageClaim } from "./store";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

type EmiContext = {
    emi_id: string;
    due_date: string;
    amount: string | null;
    amount_paid: string | null;
    status: string;
    days_overdue: number | null;
    loan_sanction_id: string;
    lead_id: string | null;
    nbfc_id: string | null;
    lender: string | null;
    customer_name: string | null;
    phone: string | null;
    next_due_date: string | null;
};

/** One EMI (or a lender's EMIs) with everything a message needs. */
function contextSql(where: ReturnType<typeof sql>) {
    return sql`
        SELECT e.id::text AS emi_id, e.due_date::text AS due_date, e.amount::text AS amount,
               e.amount_paid::text AS amount_paid, e.status, e.days_overdue,
               ls.id AS loan_sanction_id, ls.lead_id, ls.nbfc_id::text AS nbfc_id,
               t.display_name AS lender,
               COALESCE(NULLIF(l.full_name, ''), l.owner_name) AS customer_name,
               COALESCE(NULLIF(l.mobile, ''), NULLIF(l.phone, ''), l.owner_contact) AS phone,
               (SELECT n.due_date::text FROM emi_schedules n
                 WHERE n.loan_sanction_id = e.loan_sanction_id AND n.due_date > e.due_date
                   AND n.status IN ('scheduled', 'overdue', 'missed')
                 ORDER BY n.due_date LIMIT 1) AS next_due_date
          FROM emi_schedules e
          JOIN loan_sanctions ls ON ls.id = e.loan_sanction_id
          LEFT JOIN nbfc_tenants t ON t.id = ls.nbfc_id
          LEFT JOIN leads l ON l.id = ls.lead_id
         WHERE ${where}
    `;
}

function istToday(now: Date): string {
    return new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

function valuesFor(e: EmiContext, kind: EmiMessageKind, opts: { paid?: number; today: string }): EmiFieldValues {
    const due = Number(e.amount ?? 0) - Number(e.amount_paid ?? 0);
    const overdue = Math.max(0, Math.round((Date.parse(`${opts.today}T00:00:00Z`) - Date.parse(`${e.due_date}T00:00:00Z`)) / 86_400_000));
    return {
        name: e.customer_name ?? "ग्राहक",
        amount: fmtAmount(kind === "received" ? (opts.paid ?? e.amount_paid) : due > 0 ? due : e.amount),
        due_date: fmtDay(e.due_date),
        lender: e.lender ?? "",
        next_due_date: fmtDay(kind === "received" ? (e.status === "paid" || e.status === "paid_late" ? e.next_due_date : e.due_date) : e.next_due_date),
        days_overdue: String(overdue),
    };
}

/** Send one message on one channel (the claim is the caller's). */
async function deliver(
    channel: EmiChannel,
    cfg: EmiMessageConfig,
    text: string,
    phone: string,
    values: EmiFieldValues,
    settings: EmiMessagesSettings,
): Promise<{ status: "sent" | "failed" | "skipped"; providerMessageId: string | null; error: string | null }> {
    if (channel === "whatsapp") {
        if (!cfg.waTemplate.trim()) return { status: "skipped", providerMessageId: null, error: "no WhatsApp template name" };
        const { getAdapter } = await import("@/lib/whatsapp");
        const r = await getAdapter().sendTemplate(`91${phone}`, cfg.waTemplate.trim(), settings.waLanguage, templateParams(text, values));
        if (r.ok && !r.providerMessageId) return { status: "skipped", providerMessageId: null, error: "not sent (dry run or not the live site)" };
        return { status: r.ok ? "sent" : "failed", providerMessageId: r.providerMessageId, error: r.ok ? null : (r.error ?? "send failed") };
    }
    const { sendMsg91Flow } = await import("@/lib/msg91");
    const r = await sendMsg91Flow({ mobile_number: phone, template_id: cfg.smsTemplateId, variables: values as Record<string, string> });
    if (r.skipped) return { status: "skipped", providerMessageId: null, error: r.error };
    return { status: r.success ? "sent" : "failed", providerMessageId: r.messageId, error: r.success ? null : r.error };
}

/** Claim, send, record — on both channels. Returns how many were sent. */
async function claimAndSend(
    e: EmiContext,
    kind: EmiMessageKind | "reminder",
    cfg: EmiMessageConfig,
    text: string,
    values: EmiFieldValues,
    settings: EmiMessagesSettings,
    ref = "",
    channels: readonly EmiChannel[] = EMI_CHANNELS,
): Promise<number> {
    const phone = mobile10(e.phone);
    let sent = 0;
    for (const channel of channels) {
        const claim: EmiMessageClaim = {
            emiScheduleId: e.emi_id,
            loanSanctionId: e.loan_sanction_id,
            leadId: e.lead_id,
            nbfcId: e.nbfc_id,
            kind,
            channel,
            ref,
            phone,
            body: fillText(text, values),
        };
        const id = await claimEmiMessage(claim);
        if (!id) continue; // already sent for this EMI
        const out = phone
            ? await deliver(channel, cfg, text, phone, values, settings).catch((err) => ({
                  status: "failed" as const,
                  providerMessageId: null,
                  error: err instanceof Error ? err.message : String(err),
              }))
            : { status: "skipped" as const, providerMessageId: null, error: "no valid customer mobile on the file" };
        await finishEmiMessage(id, claim, out);
        if (out.status === "sent") sent++;
    }
    return sent;
}

/**
 * The daily job. Safe to run every hour: before the send hour it only ages;
 * after it each message is claimed once per EMI.
 */
export async function runEmiMessages(now = new Date()): Promise<{ aged: boolean; sent: number }> {
    const { runEmiAging } = await import("@/lib/nbfc/servicing/runEmiAging");
    await runEmiAging();

    const settings = await getEmiMessagesSettings();
    if (!settings.enabled || !settings.pilotNbfcId || !(await hasEmiMessages())) return { aged: true, sent: 0 };
    // Off the live site a job's sends are dropped (ID 125) — do not claim
    // messages that would then never go.
    const { jobSendsAllowed } = await import("@/lib/runtime/liveSite");
    if (!jobSendsAllowed()) return { aged: true, sent: 0 };
    const hourIst = new Date(now.getTime() + 5.5 * 3600_000).getUTCHours();
    if (hourIst < settings.sendFromHourIst || hourIst >= 21) return { aged: true, sent: 0 };

    const today = istToday(now);
    const days = Object.values(settings.messages).map((m) => m.day);
    const minDay = Math.min(...days);
    const maxDay = Math.max(...days);
    const emis = rowsOf<EmiContext>(
        await db.execute(contextSql(sql`
            ls.nbfc_id = ${settings.pilotNbfcId}::uuid
            AND e.status IN ('scheduled', 'overdue', 'missed')
            AND e.amount_paid < COALESCE(e.amount, 0)
            AND e.due_date BETWEEN (${today}::date - ${maxDay}::int) AND (${today}::date - ${minDay}::int)
        `)),
    );

    let sent = 0;
    for (const e of emis) {
        for (const kind of dueKindsFor({ dueDate: e.due_date, unpaid: true }, today, settings.messages)) {
            const cfg = settings.messages[kind];
            sent += await claimAndSend(e, kind, cfg, cfg.text!, valuesFor(e, kind, { today }), settings);
        }
    }
    return { aged: true, sent };
}

/**
 * "EMI received" after a recorded payment. Call AFTER the payment's
 * transaction commits; never throws (a failed message must not fail a
 * payment). `paymentRef` makes it once per payment.
 */
export async function queueEmiReceived(input: { emiId: string; amount?: number | null; paymentRef: string | null }): Promise<void> {
    try {
        const settings = await getEmiMessagesSettings();
        const cfg = settings.messages.received;
        if (!settings.enabled || !settings.pilotNbfcId || !cfg.on || !cfg.text) return;
        if (!(await hasEmiMessages())) return;
        const [e] = rowsOf<EmiContext>(await db.execute(contextSql(sql`e.id = ${input.emiId}::uuid`)));
        if (!e || e.nbfc_id !== settings.pilotNbfcId) return;
        const today = istToday(new Date());
        const ref = (input.paymentRef ?? `paid-${e.amount_paid}`).slice(0, 100);
        await claimAndSend(e, "received", cfg, cfg.text, valuesFor(e, "received", { paid: input.amount ?? undefined, today }), settings, ref);
    } catch (err) {
        console.error("[emi-messages] received message failed:", err instanceof Error ? err.message : err);
    }
}

/**
 * The lender portal's "Send payment reminder": the oldest unpaid EMI of the
 * loan, the overdue text when it is overdue, else the due-soon text, on the
 * chosen channel — now, once per portal action. Any lender (not just the
 * pilot) once the messages are switched on.
 */
export async function sendPortalReminder(input: {
    loanSanctionId: string;
    channel: "sms" | "whatsapp" | "email";
    actionId: string;
}): Promise<{ sent: boolean; reason?: string }> {
    if (input.channel === "email") return { sent: false, reason: "Email reminders are not set up; use SMS or WhatsApp." };
    const settings = await getEmiMessagesSettings();
    if (!settings.enabled) return { sent: false, reason: "EMI messages are switched off (Admin > Settings > EMI messages)." };
    if (!(await hasEmiMessages())) return { sent: false, reason: "EMI messages are not set up on this server yet (E-365)." };
    const [e] = rowsOf<EmiContext>(
        await db.execute(sql`${contextSql(sql`
            e.loan_sanction_id = ${input.loanSanctionId}
            AND e.status IN ('scheduled', 'overdue', 'missed')
            AND e.amount_paid < COALESCE(e.amount, 0)
        `)} ORDER BY e.due_date LIMIT 1`),
    );
    if (!e) return { sent: false, reason: "No unpaid EMI on this loan." };
    const today = istToday(new Date());
    const kind: EmiMessageKind = e.due_date < today ? "overdue_1" : e.due_date === today ? "due_today" : "due_3d";
    const cfg = settings.messages[kind];
    if (!cfg.text) return { sent: false, reason: `The "${kind}" text is not approved yet.` };
    const n = await claimAndSend(e, "reminder", cfg, cfg.text, valuesFor(e, kind, { today }), settings, input.actionId, [input.channel]);
    return n > 0 ? { sent: true } : { sent: false, reason: "The message could not be sent (see the file's history)." };
}

/**
 * Admin test send: each message (or one) to `phone` on WhatsApp and SMS with
 * sample values — the PENDING text when there is one, so a new text can be
 * tried before it is approved. Recorded with is_test, no EMI, no history.
 */
export async function sendEmiTestMessages(input: {
    phone: string;
    kinds?: EmiMessageKind[];
}): Promise<Array<{ kind: EmiMessageKind; channel: EmiChannel; status: string; error: string | null }>> {
    const phone = mobile10(input.phone);
    if (!phone) throw Object.assign(new Error("Give a 10-digit Indian mobile number."), { status: 400 });
    if (!(await hasEmiMessages())) throw Object.assign(new Error("EMI messages are not set up on this server yet (E-365)."), { status: 503 });
    const settings = await getEmiMessagesSettings();
    const sample: EmiFieldValues = {
        name: "राम कुमार",
        amount: fmtAmount(4250),
        due_date: fmtDay(istToday(new Date())),
        lender: "Test Lender",
        next_due_date: fmtDay(istToday(new Date(Date.now() + 30 * 86_400_000))),
        days_overdue: "3",
    };
    const out: Array<{ kind: EmiMessageKind; channel: EmiChannel; status: string; error: string | null }> = [];
    for (const kind of input.kinds?.length ? input.kinds : EMI_MESSAGE_KINDS) {
        const cfg = settings.messages[kind];
        const text = cfg.pendingText ?? cfg.text;
        if (!text) continue;
        for (const channel of EMI_CHANNELS) {
            const claim: EmiMessageClaim = {
                emiScheduleId: null,
                loanSanctionId: "TEST",
                leadId: null,
                nbfcId: null,
                kind,
                channel,
                phone,
                body: fillText(text, sample),
                isTest: true,
            };
            const id = await claimEmiMessage(claim);
            const r = await deliver(channel, cfg, text, phone, sample, settings).catch((err) => ({
                status: "failed" as const,
                providerMessageId: null,
                error: err instanceof Error ? err.message : String(err),
            }));
            if (id) await finishEmiMessage(id, claim, r);
            out.push({ kind, channel, status: r.status, error: r.error });
        }
    }
    return out;
}

/**
 * The daily line per lender (the EMI messages digest): yesterday's sends —
 * sent, delivered, failed — and how many of the EMIs messaged were paid
 * within 3 days of their first message (over the messages of 3 days ago,
 * the last day that window has closed for).
 */
export async function emiMessagesDailyLines(istDay: string): Promise<
    Array<{ lender: string; sent: number; delivered: number; failed: number; paid_within_3d: number; messaged_3d_ago: number }>
> {
    if (!(await hasEmiMessages())) return [];
    return rowsOf(
        await db.execute(sql`
            WITH day AS (
                SELECT m.* FROM emi_customer_messages m
                 WHERE NOT m.is_test
                   AND (m.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${istDay}::date
            ), win AS (
                SELECT m.nbfc_id, m.emi_schedule_id, MIN(m.created_at) AS first_at
                  FROM emi_customer_messages m
                 WHERE NOT m.is_test AND m.kind <> 'received' AND m.status IN ('sent', 'delivered', 'read')
                   AND (m.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${istDay}::date - 3
                 GROUP BY 1, 2
            )
            SELECT COALESCE(t.display_name, 'Unknown lender') AS lender,
                   COALESCE(d.sent, 0)::int AS sent, COALESCE(d.delivered, 0)::int AS delivered,
                   COALESCE(d.failed, 0)::int AS failed,
                   COALESCE(w.paid, 0)::int AS paid_within_3d, COALESCE(w.n, 0)::int AS messaged_3d_ago
              FROM (SELECT nbfc_id FROM day UNION SELECT nbfc_id FROM win) ids
              LEFT JOIN nbfc_tenants t ON t.id = ids.nbfc_id
              LEFT JOIN (
                  SELECT nbfc_id,
                         COUNT(*) FILTER (WHERE status IN ('sent', 'delivered', 'read')) AS sent,
                         COUNT(*) FILTER (WHERE status IN ('delivered', 'read')) AS delivered,
                         COUNT(*) FILTER (WHERE status = 'failed') AS failed
                    FROM day GROUP BY 1) d ON d.nbfc_id IS NOT DISTINCT FROM ids.nbfc_id
              LEFT JOIN (
                  SELECT w.nbfc_id, COUNT(*) AS n,
                         COUNT(*) FILTER (WHERE e.paid_at IS NOT NULL AND e.paid_at <= w.first_at + INTERVAL '3 days') AS paid
                    FROM win w JOIN emi_schedules e ON e.id = w.emi_schedule_id
                   GROUP BY 1) w ON w.nbfc_id IS NOT DISTINCT FROM ids.nbfc_id
             ORDER BY 1
        `),
    );
}
