/**
 * Tracker ID 204 — EMI follow-up and "EMI received" messages to the customer
 * of a financed file. CLIENT-SAFE, pure (no db import): the settings page and
 * the sender share these rules.
 *
 * Kartik, 28 Oct: pilot on one lender; all messages in Hindi, text set by
 * Admin; WhatsApp AND SMS. Five scheduled messages, each once per EMI and only
 * while it is unpaid — due in 3 days, due today, overdue day 1 / 3 / 7 — plus
 * "received Rs X, next EMI due <date>" on every recorded payment.
 *
 * Meta (WhatsApp) and DLT (SMS) approve the EXACT text, so an edited text
 * waits: sends keep using the approved text until Admin marks the new one
 * approved. Database side: ./settings.ts, ./store.ts, ./run.ts.
 */

export const EMI_SCHEDULED_KINDS = ["due_3d", "due_today", "overdue_1", "overdue_3", "overdue_7"] as const;
export type EmiScheduledKind = (typeof EMI_SCHEDULED_KINDS)[number];
export const EMI_MESSAGE_KINDS = [...EMI_SCHEDULED_KINDS, "received"] as const;
export type EmiMessageKind = (typeof EMI_MESSAGE_KINDS)[number];
export type EmiChannel = "whatsapp" | "sms";
export const EMI_CHANNELS: readonly EmiChannel[] = ["whatsapp", "sms"];

/** The fixed fields a text may use, e.g. "{amount}". */
export const EMI_FIELDS = ["name", "amount", "due_date", "lender", "next_due_date", "days_overdue"] as const;
export type EmiField = (typeof EMI_FIELDS)[number];
export type EmiFieldValues = Partial<Record<EmiField, string>>;

export const EMI_KIND_LABEL: Record<EmiMessageKind, string> = {
    due_3d: "EMI due soon",
    due_today: "EMI due today",
    overdue_1: "Overdue (1st)",
    overdue_3: "Overdue (2nd)",
    overdue_7: "Overdue (3rd)",
    received: "EMI received",
};

export type EmiMessageConfig = {
    on: boolean;
    /** Days from the due date: negative = before, 0 = the due day, positive = overdue. Not used by "received". */
    day: number;
    /** The APPROVED text — what is sent. Null = nothing approved yet: this message is not sent. */
    text: string | null;
    /** An edited text waiting for Meta / DLT approval. */
    pendingText: string | null;
    /** Meta template name (its body must match the approved text, fields in the same order). */
    waTemplate: string;
    /** Unused since 30 Oct (SMS go through Exotel by DLT template id); kept so saved settings still read. */
    smsTemplateId: string;
    /** DLT template id — Exotel sends the SMS under it (the text must be the DLT text, fields filled). */
    dltTemplateId: string;
    /**
     * 30 Oct: the SMS goes with the same text as WhatsApp (Admin's choice);
     * this is only for when DLT approves a different wording. Empty = the
     * WhatsApp text. Filled with smsValues().
     */
    smsText: string;
};

export type EmiMessagesSettings = {
    /** Master switch. Off = nothing is sent (ships off). */
    enabled: boolean;
    /** The one pilot lender (nbfc_tenants.id). Null = nobody gets the scheduled messages. */
    pilotNbfcId: string | null;
    /** Meta template language code. */
    waLanguage: string;
    /** Scheduled messages go out from this hour (IST). */
    sendFromHourIst: number;
    messages: Record<EmiMessageKind, EmiMessageConfig>;
    updatedBy: string | null;
    updatedAt: string | null;
};

const DEFAULT_TEXT: Record<EmiMessageKind, string> = {
    due_3d: "नमस्ते {name}, आपकी EMI ₹{amount} {due_date} को देय है। कृपया समय पर भुगतान करें। – {lender} टीम",
    due_today: "नमस्ते {name}, आपकी EMI ₹{amount} आज ({due_date}) देय है। कृपया आज ही भुगतान करें। – {lender} टीम",
    overdue_1: "नमस्ते {name}, आपकी EMI ₹{amount} ({due_date} को देय) अभी तक नहीं मिली है। कृपया जल्द भुगतान करें। – {lender} टीम",
    overdue_3: "नमस्ते {name}, आपकी EMI ₹{amount} {days_overdue} दिन से बकाया है ({due_date} को देय)। कृपया तुरंत भुगतान करें। – {lender} टीम",
    overdue_7: "नमस्ते {name}, आपकी EMI ₹{amount} {days_overdue} दिन से बकाया है। देरी से आपका क्रेडिट स्कोर प्रभावित हो सकता है। कृपया आज ही भुगतान करें। – {lender} टीम",
    received: "नमस्ते {name}, आपकी EMI ₹{amount} प्राप्त हो गई है। धन्यवाद! अगली EMI {next_due_date} को देय है। – {lender} टीम",
};

const DEFAULT_DAY: Record<EmiMessageKind, number> = {
    due_3d: -3,
    due_today: 0,
    overdue_1: 1,
    overdue_3: 3,
    overdue_7: 7,
    received: 0,
};

/**
 * The defaults: every message on, with a Hindi draft as PENDING text — none is
 * approved, so nothing is sent until Admin has the templates approved and
 * marks them so. Master switch off, no pilot lender.
 */
export function defaultEmiMessagesSettings(): EmiMessagesSettings {
    const messages = {} as Record<EmiMessageKind, EmiMessageConfig>;
    for (const k of EMI_MESSAGE_KINDS) {
        messages[k] = {
            on: true,
            day: DEFAULT_DAY[k],
            text: null,
            pendingText: DEFAULT_TEXT[k],
            waTemplate: `emi_${k}_hi`,
            smsTemplateId: "",
            dltTemplateId: "",
            smsText: "",
        };
    }
    return { enabled: false, pilotNbfcId: null, waLanguage: "hi", sendFromHourIst: 10, messages, updatedBy: null, updatedAt: null };
}

/** The "{field}" names in a text, in order, repeats kept (a WhatsApp template's body parameters). */
export function textFields(text: string): string[] {
    return [...text.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]!);
}

/** Fields a text uses that are not in EMI_FIELDS — must be empty to save. */
export function unknownFields(text: string): string[] {
    return [...new Set(textFields(text).filter((f) => !(EMI_FIELDS as readonly string[]).includes(f)))];
}

/** The text with its fields filled; a missing value prints as "-". */
export function fillText(text: string, values: EmiFieldValues): string {
    return text.replace(/\{([a-z_]+)\}/g, (_, f: string) => values[f as EmiField] ?? "-");
}

/** The WhatsApp body parameters for a text, in the order the fields appear. */
export function templateParams(text: string, values: EmiFieldValues): string[] {
    return textFields(text).map((f) => values[f as EmiField] ?? "-");
}

/** Whole days from `from` to `to` (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
    return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * The scheduled messages due today for one EMI: each one switched on, with
 * an approved text, whose day matches (today − due date), and only while the
 * EMI is unpaid. "Once per EMI" is the store's claim row, not this.
 */
export function dueKindsFor(
    emi: { dueDate: string; unpaid: boolean },
    today: string,
    messages: Record<EmiMessageKind, EmiMessageConfig>,
): EmiScheduledKind[] {
    if (!emi.unpaid) return [];
    const offset = daysBetween(emi.dueDate, today);
    return EMI_SCHEDULED_KINDS.filter((k) => {
        const m = messages[k];
        return m.on && !!m.text && m.day === offset;
    });
}

/**
 * Saving an edited text: the approved text stays what is sent; a different
 * new text becomes the pending one (an unchanged one clears pending).
 */
export function editText(cfg: EmiMessageConfig, newText: string): EmiMessageConfig {
    const t = newText.trim();
    if (t === (cfg.text ?? "")) return { ...cfg, pendingText: null };
    return { ...cfg, pendingText: t };
}

/** Admin marks the pending text approved (Meta + DLT): it becomes the sent text. */
export function approveText(cfg: EmiMessageConfig): EmiMessageConfig {
    return cfg.pendingText ? { ...cfg, text: cfg.pendingText, pendingText: null } : cfg;
}

/** "₹12,500" style amount without the sign (the text carries ₹). */
export function fmtAmount(n: number | string | null | undefined): string {
    const v = Number(n ?? 0);
    return Number.isFinite(v) ? v.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "-";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The SMS values: DLT typed variables match only their own characters — a
 * {#number#} digits only (so "4,250" goes as "4250"), an {#alphanumeric#}
 * letters and digits (so "05-11-2026" goes as "05Nov2026").
 */
export function smsValues(values: EmiFieldValues): EmiFieldValues {
    const day = (v: string | undefined) => {
        const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(v ?? "");
        return m ? `${m[1]}${MONTHS[Number(m[2]) - 1] ?? m[2]}${m[3]}` : v;
    };
    const amount = Number((values.amount ?? "").replace(/,/g, ""));
    return {
        ...values,
        amount: Number.isFinite(amount) && values.amount ? String(Math.round(amount)) : values.amount,
        due_date: day(values.due_date),
        next_due_date: day(values.next_due_date),
    };
}

/** "05-11-2026" — the date form used in the texts. */
export function fmtDay(day: string | null | undefined): string {
    if (!day) return "-";
    const [y, m, d] = day.slice(0, 10).split("-");
    return y && m && d ? `${d}-${m}-${y}` : day;
}

/** Last 10 digits of an Indian mobile, or null. */
export function mobile10(phone: string | null | undefined): string | null {
    const d = (phone ?? "").replace(/\D/g, "").slice(-10);
    return /^[6-9]\d{9}$/.test(d) ? d : null;
}
