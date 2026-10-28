/**
 * Wording and recipient rules for the KYC action log (kycEventLog.ts). Pure —
 * no database — so the unit tests import it directly.
 */

/**
 * ID 201 — who acted, as the history shows it: the dealer who owns the file
 * (or one of its WhatsApp salespeople), the iTarang house login, iTarang staff
 * (Admin, Sales Head …) acting for the dealer, a customer on WhatsApp, or the
 * system.
 */
export type KycActorType = "dealer" | "salesperson" | "house" | "itarang" | "customer" | "system";
/** ID 201 — where the step was taken. */
export type KycChannel = "web" | "whatsapp" | "system";

export interface KycActor {
    /** users.id; null for the system (auto-approval, provider callbacks). */
    id: string | null;
    name: string | null;
    role: string | null;
    /** ID 201: absent = worked out from id / role (kycActorType). */
    type?: KycActorType;
    /** ID 201: absent = web for a person, system for the system. */
    channel?: KycChannel;
    /** ID 201: the dealer whose file it is, when someone else acted for them. */
    forDealerId?: string | null;
    forDealerName?: string | null;
}

/** ID 201 — the actor type when the caller did not say. */
export function kycActorType(actor: Pick<KycActor, "id" | "role" | "type">): KycActorType {
    if (actor.type) return actor.type;
    const role = (actor.role ?? "").toLowerCase();
    if (!actor.id && (!role || role === "system")) return "system";
    if (role === "dealer") return "dealer";
    if (role === "salesperson") return "salesperson";
    if (role === "customer") return "customer";
    return "itarang";
}

export function kycChannel(actor: Pick<KycActor, "id" | "role" | "type" | "channel">): KycChannel {
    return actor.channel ?? (kycActorType(actor) === "system" ? "system" : "web");
}

/** ID 201 #6 — the owning dealer never sees iTarang people's names. */
export const ITARANG_TEAM = "iTarang team";

/**
 * ID 201 — the name a viewer sees for a line. The owning dealer sees their own
 * people (their login, their salespeople, their customer) by name and everyone
 * at iTarang — staff and the house login — as "iTarang team". iTarang logins
 * see every name.
 */
export function kycWhoFor(
    viewer: "owning_dealer" | "itarang",
    row: { byName: string | null; actorType: KycActorType },
): string | null {
    if (viewer === "owning_dealer" && (row.actorType === "itarang" || row.actorType === "house")) return ITARANG_TEAM;
    return row.byName;
}

/** ID 201 #5 — "WhatsApp · iTarang house · for Sharma Batteries". */
export function kycLineTags(row: {
    channel: KycChannel;
    actorType: KycActorType;
    forDealerName: string | null;
}): string[] {
    const tags: string[] = [];
    if (row.channel === "web") tags.push("Web");
    if (row.channel === "whatsapp") tags.push("WhatsApp");
    if (row.actorType === "house") tags.push("iTarang house");
    if (row.actorType === "salesperson") tags.push("Dealer's salesperson");
    if (row.actorType === "customer") tags.push("Customer");
    if ((row.actorType === "house" || row.actorType === "itarang") && row.forDealerName) tags.push(`for ${row.forDealerName}`);
    return tags;
}

const ROLE_LABEL: Record<string, string> = {
    admin: "Admin",
    sales_head: "Sales Head",
    dealer: "Dealer",
    ceo: "CEO",
    business_head: "Business Head",
    system: "System",
};

export function actorLabel(actor: KycActor): string {
    const role = (actor.role ?? "").toLowerCase();
    const type = kycActorType(actor);
    if (type === "system") return "iTarang (automatic)";
    // ID 201: the house login has role 'dealer' but is iTarang.
    if (type === "house") return `${actor.name?.trim() || "Someone"} (iTarang house)`;
    if (type === "salesperson") return `${actor.name?.trim() || "Salesperson"} (dealer's salesperson)`;
    if (type === "customer") return `${actor.name?.trim() || "The customer"} (customer)`;
    if (!actor.id && (!role || role === "system")) return "iTarang (automatic)";
    const name = actor.name?.trim() || "Someone";
    const r = ROLE_LABEL[role] ?? (role ? role.replace(/_/g, " ") : "");
    return r ? `${name} (${r})` : name;
}

/** "26 Oct 2026, 3:05 pm" in IST. */
export function istTime(at: Date): string {
    return at.toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "Asia/Kolkata",
    });
}

export function kycEventMessage(p: {
    customerName: string;
    referenceId: string;
    action: string;
    actor: string;
    at: Date;
}): string {
    return (
        `📋 *KYC update* — ${p.customerName} (Ref: ${p.referenceId})\n\n` +
        `${p.action}\nBy: ${p.actor}\nAt: ${istTime(p.at)}`
    );
}

/** users.phone is free text; Meta wants digits with the country code. */
export function waNumber(raw: string | null | undefined): string | null {
    const digits = (raw ?? "").replace(/\D/g, "");
    if (digits.length === 10) return `91${digits}`;
    if (digits.length === 12 && digits.startsWith("91")) return digits;
    if (digits.length === 11 && digits.startsWith("0")) return `91${digits.slice(1)}`;
    return null;
}

/**
 * Who gets the line: one entry per distinct WhatsApp number, without the
 * person who acted (by user id, or by their own number).
 */
export function kycRecipients(
    people: Array<{ user_id: string; phone: string | null }>,
    actor: { id: string | null; phone?: string | null },
): string[] {
    const actorPhone = waNumber(actor.phone);
    const out = new Set<string>();
    for (const p of people) {
        if (actor.id && p.user_id === actor.id) continue;
        const n = waNumber(p.phone);
        if (!n || n === actorPhone) continue;
        out.add(n);
    }
    return [...out];
}

const CARD_LABEL: Record<string, string> = { pan: "PAN", aadhaar: "Aadhaar", rc: "RC", cibil: "CIBIL", gst: "GST" };

/** "pan" → "PAN", "bank_account" → "Bank account", for log lines. */
export function kycCardLabel(type: string | null | undefined, applicant?: string | null): string {
    const t = (type ?? "").toLowerCase();
    const base = CARD_LABEL[t] ?? (t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, " ") : "KYC");
    return /co_?borrower/i.test(applicant ?? "") ? `${base} (co-borrower)` : base;
}

const withReason = (line: string, reason: string | null | undefined) =>
    reason?.trim() ? `${line}: ${reason.trim()}` : line;

/** Admin card / document / consent decisions, worded the same everywhere. */
export function kycDecisionLine(what: string, decision: string, reason?: string | null): string {
    const d = decision.toLowerCase();
    if (d === "request_more_docs") return withReason(`${what}: more documents requested`, reason);
    if (/^(accept|approve|verified)/.test(d)) return `${what} approved`;
    if (/^(reject|admin_rejected|failed)/.test(d)) return withReason(`${what} rejected`, reason);
    return withReason(`${what}: ${d.replace(/_/g, " ")}`, reason);
}


/**
 * ID 201 #2 — "passed" / "failed" for a check's result, whatever shape the
 * provider service returned ({ success }, { ok }, { status, body }); null
 * when it cannot be told.
 */
export function kycCheckOutcome(result: unknown): "passed" | "failed" | null {
    if (!result || typeof result !== "object") return null;
    const r = result as Record<string, unknown>;
    if (typeof r.status === "number" && "body" in r) {
        if (r.status >= 400) return "failed";
        return kycCheckOutcome(r.body) ?? "passed";
    }
    if (typeof r.success === "boolean") return r.success ? "passed" : "failed";
    if (typeof r.ok === "boolean") return r.ok ? "passed" : "failed";
    return null;
}
