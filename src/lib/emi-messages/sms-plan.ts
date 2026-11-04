/**
 * EMI SMS plan (4 Nov) — CLIENT-SAFE, pure. Which SMS goes on which day, and
 * with which DLT template.
 *
 * Business, 4 Nov: SMS go on DLT templates with as few variables as possible,
 * so the due DAY is written into the text — 31 reminder templates, one per
 * day of the month ("देय तिथि 20 तारीख है"), each with {lender} and {amount}.
 * Plus: "due today" ("आज देय है"), one overdue template with the TOTAL unpaid
 * on the loan ({total_due}, {lender}) and "received" ({paid_date}, {amount}).
 *
 * The schedule is Admin's / Sales Head's: reminders N days before (e.g. 7, 5,
 * 1 — each sends the template of the EMI's own due day), the due-day "आज"
 * message, and overdue daily / every N days / on listed days, up to a limit.
 * Each step goes once per EMI (the claim ref is the step: b7, o3, ...).
 *
 * An EMI due on the 31st that falls on the 30th in a short month gets the
 * day-30 template: the day is always the EMI's actual due date.
 */

export type EmiSmsTemplate = {
    /** The DLT template id Exotel sends under. Empty = this SMS is not sent. */
    dltTemplateId: string;
    /** The DLT-registered text with fields as {lender} / {amount} / {total_due} / {paid_date}. */
    text: string;
};

export const OVERDUE_MODES = ["daily", "every", "days"] as const;
export type OverdueMode = (typeof OVERDUE_MODES)[number];

export type EmiSmsPlan = {
    /** Days before the due date a reminder goes, e.g. [7, 5, 1]. */
    beforeDays: number[];
    /** The due-day "आज देय है" message. */
    dueToday: boolean;
    overdue: {
        on: boolean;
        /** daily | every `every` days from day 1 | only on `days`. */
        mode: OverdueMode;
        every: number;
        days: number[];
        /** No overdue SMS after this many days overdue. */
        stopAfter: number;
    };
    /** Index 0 = due day 1 … index 30 = due day 31. */
    reminders: EmiSmsTemplate[];
    dueTodayTpl: EmiSmsTemplate;
    overdueTpl: EmiSmsTemplate;
    receivedTpl: EmiSmsTemplate;
};

/** The SMS kinds in emi_customer_messages (E-371), beside "received" and "reminder". */
export type EmiSmsStepKind = "sms_before" | "sms_due_today" | "sms_overdue";
export type EmiSmsStep = { kind: EmiSmsStepKind; ref: string };

export const SUPPORT_LINE = " सहायता हेतु कॉल करें: 8796278200 – iTarang Technologies LLP";
export const IGNORE_LINE = " यदि आपने पहले ही भुगतान कर दिया है, तो कृपया इस संदेश को अनदेखा करें।";

export const reminderText = (day: number) =>
    `नमस्ते, आपकी {lender} लोन की EMI ₹{amount} की देय तिथि ${day} तारीख है। कृपया समय पर भुगतान करें।${IGNORE_LINE}${SUPPORT_LINE}`;
export const DUE_TODAY_TEXT = `नमस्ते, आपकी {lender} लोन की EMI ₹{amount} आज देय है। कृपया आज ही भुगतान करें।${IGNORE_LINE}${SUPPORT_LINE}`;
export const OVERDUE_TEXT = `प्रिय सम्मानित ग्राहक, ₹{total_due} की कुल बकाया EMI राशि आपके {lender} लोन पर अभी तक जमा नहीं हुई है। कृपया जल्द से जल्द भुगतान करें।${IGNORE_LINE}${SUPPORT_LINE}`;
export const RECEIVED_TEXT = `नमस्ते, दिनांक {paid_date} को आपकी EMI ₹{amount} प्राप्त हो गई है। समय पर भुगतान के लिए धन्यवाद!${SUPPORT_LINE}`;

export function defaultSmsPlan(): EmiSmsPlan {
    return {
        beforeDays: [7, 5, 1],
        dueToday: true,
        overdue: { on: true, mode: "daily", every: 3, days: [1, 3, 7, 15, 30], stopAfter: 30 },
        reminders: Array.from({ length: 31 }, (_, i) => ({ dltTemplateId: "", text: reminderText(i + 1) })),
        dueTodayTpl: { dltTemplateId: "", text: DUE_TODAY_TEXT },
        overdueTpl: { dltTemplateId: "", text: OVERDUE_TEXT },
        receivedTpl: { dltTemplateId: "", text: RECEIVED_TEXT },
    };
}

/** Whole numbers in [min, max], unique, largest first. */
export function cleanDays(v: unknown, min: number, max: number): number[] {
    const arr = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : [];
    const out = new Set<number>();
    for (const x of arr) {
        const n = Number(x);
        if (Number.isInteger(n) && n >= min && n <= max) out.add(n);
    }
    return [...out].sort((a, b) => b - a);
}

const intIn = (v: unknown, min: number, max: number, d: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : d;
};

function tpl(v: unknown, def: EmiSmsTemplate): EmiSmsTemplate {
    const o = (v ?? {}) as Record<string, unknown>;
    return {
        dltTemplateId: typeof o.dltTemplateId === "string" ? o.dltTemplateId.trim() : def.dltTemplateId,
        text: typeof o.text === "string" && o.text.trim() ? o.text.trim() : def.text,
    };
}

/** A stored plan merged over the defaults, field by field. */
export function normaliseSmsPlan(v: unknown): EmiSmsPlan {
    const d = defaultSmsPlan();
    const s = (v ?? {}) as Record<string, unknown>;
    const o = (s.overdue ?? {}) as Record<string, unknown>;
    const rem = Array.isArray(s.reminders) ? s.reminders : [];
    return {
        beforeDays: Array.isArray(s.beforeDays) ? cleanDays(s.beforeDays, 1, 30) : d.beforeDays,
        dueToday: typeof s.dueToday === "boolean" ? s.dueToday : d.dueToday,
        overdue: {
            on: typeof o.on === "boolean" ? o.on : d.overdue.on,
            mode: (OVERDUE_MODES as readonly string[]).includes(o.mode as string) ? (o.mode as OverdueMode) : d.overdue.mode,
            every: intIn(o.every, 2, 30, d.overdue.every),
            days: Array.isArray(o.days) ? cleanDays(o.days, 1, 180).reverse() : d.overdue.days,
            stopAfter: intIn(o.stopAfter, 1, 180, d.overdue.stopAfter),
        },
        reminders: d.reminders.map((def, i) => tpl(rem[i], def)),
        dueTodayTpl: tpl(s.dueTodayTpl, d.dueTodayTpl),
        overdueTpl: tpl(s.overdueTpl, d.overdueTpl),
        receivedTpl: tpl(s.receivedTpl, d.receivedTpl),
    };
}

/**
 * The SMS step for an EMI `offset` days from its due date (today − due date:
 * negative = before, 0 = the due day, positive = overdue), or null.
 */
export function smsStepFor(offset: number, plan: EmiSmsPlan): EmiSmsStep | null {
    if (offset < 0) return plan.beforeDays.includes(-offset) ? { kind: "sms_before", ref: `b${-offset}` } : null;
    if (offset === 0) return plan.dueToday ? { kind: "sms_due_today", ref: "" } : null;
    const o = plan.overdue;
    if (!o.on || offset > o.stopAfter) return null;
    const hit = o.mode === "daily" ? true : o.mode === "every" ? (offset - 1) % o.every === 0 : o.days.includes(offset);
    return hit ? { kind: "sms_overdue", ref: `o${offset}` } : null;
}

/** The day of the month of a YYYY-MM-DD date. */
export const dayOfMonth = (day: string) => Number(day.slice(8, 10));

/** The template a step sends; reminders by the EMI's own due day. */
export function smsTemplateFor(kind: EmiSmsStepKind | "received", dueDate: string, plan: EmiSmsPlan): EmiSmsTemplate {
    if (kind === "sms_before") return plan.reminders[dayOfMonth(dueDate) - 1] ?? plan.reminders[0]!;
    if (kind === "sms_due_today") return plan.dueTodayTpl;
    if (kind === "sms_overdue") return plan.overdueTpl;
    return plan.receivedTpl;
}

/** How far around today the job must look: [days overdue, days ahead]. */
export function smsWindow(plan: EmiSmsPlan): { maxOverdue: number; maxBefore: number } {
    return {
        maxOverdue: plan.overdue.on ? plan.overdue.stopAfter : 0,
        maxBefore: plan.beforeDays.length ? Math.max(...plan.beforeDays) : 0,
    };
}

/** Overdue days on which an SMS goes, up to stopAfter. */
export function overdueSendDays(plan: EmiSmsPlan): number[] {
    const out: number[] = [];
    for (let d = 1; d <= plan.overdue.stopAfter; d++) if (smsStepFor(d, plan)) out.push(d);
    return out;
}

/** The fixed fields as DLT variables (amounts digits only, dates without dashes). */
const DLT_VAR: Record<string, string> = {
    amount: "{#numeric#}",
    total_due: "{#numeric#}",
    pending_emis: "{#numeric#}",
    days_overdue: "{#numeric#}",
    due_date: "{#alphanumeric#}",
    next_due_date: "{#alphanumeric#}",
    paid_date: "{#alphanumeric#}",
};

/** The text as it is registered on DLT: "{lender}" → {#var#}, "{amount}" → {#numeric#}, … */
export function toDltText(text: string): string {
    return text.replace(/\{([a-z_]+)\}/g, (_, f: string) => DLT_VAR[f] ?? "{#var#}");
}
