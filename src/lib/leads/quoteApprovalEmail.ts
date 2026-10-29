/**
 * Quotation approval emails (28 Oct, item 3) — for lead quotes (ISR / ASM,
 * dealer_lead_commercials) and account quotes (My Dealers, account_quotations)
 * alike.
 *
 *   sendQuoteApprovalRequestEmail   a quote parked for the CEO.
 *       To  every active CEO
 *       CC  the salesperson who raised it, their reporting manager
 *           (users.reports_to, when E-335 is applied and one is set) and
 *           care@itarang.com + anirudh@itarang.com
 *           (QUOTATION_APPROVAL_CC_EMAIL overrides that fixed pair).
 *
 *   sendQuoteApprovedEmail          the CEO approved it.
 *       To  the salesperson who raised it and the lead / account owner
 *       CC  their reporting managers and the same fixed pair
 *
 * ONE email with real CCs, so everyone sees who else was told — emit() sends a
 * plain To-list. The bell notification is still written by emit(); the callers
 * switch emit()'s own email off for the people this already reached, and fall
 * back to it when this sends nothing (no CEO with an email, mailer down).
 *
 * The table carries product, qty, unit price, amount, GST and the total incl.
 * GST. NEVER the OEM reference price: the salesperson is copied, and OEM is
 * internal. Never throws — a failed email must not undo a quote or a decision.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { sendEmail } from "@/lib/email/mailer";
import type { CommercialsProductLine } from "@/lib/inside-sales/types";
import { buildQuotePreview } from "@/lib/inside-sales/quotePreview";
import { DEFAULT_TAX_BY_ASSET_TYPE, taxRefKey } from "@/lib/leads/quote-pdf/view";
import { loadLineTaxRefs } from "@/lib/leads/quote-pdf/view-store";
import { hasReportsToColumn } from "@/lib/users/reportingLines";

// care@ — 28 Oct meeting; anirudh@ — asked for on both emails the same day.
const DEFAULT_CARE_CC = "care@itarang.com,anirudh@itarang.com";

const APP_URL = () =>
    (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "https://app.itarang.com").replace(/\/+$/, "");

/** The fixed CC — env-overridable, comma-separated; "" turns it off. */
export function careCcEmails(): string[] {
    const raw = process.env.QUOTATION_APPROVAL_CC_EMAIL ?? DEFAULT_CARE_CC;
    return raw
        .split(",")
        .map((e) => e.trim())
        .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}

/** To first, then CC with anything already in To removed; case-insensitive dedupe. */
export function splitRecipients(to: Array<string | null | undefined>, cc: Array<string | null | undefined>) {
    const seen = new Set<string>();
    const take = (list: Array<string | null | undefined>) =>
        list
            .map((e) => e?.trim())
            .filter((e): e is string => !!e)
            .filter((e) => {
                const k = e.toLowerCase();
                if (seen.has(k)) return false;
                seen.add(k);
                return true;
            });
    const toOut = take(to);
    return { to: toOut, cc: take(cc) };
}

type Person = { id: string; name: string | null; email: string | null };

/** Active users by id, with each one's reporting manager when E-335 is applied. */
async function loadPeople(ids: Array<string | null | undefined>): Promise<{ people: Person[]; managers: Person[] }> {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    if (wanted.length === 0) return { people: [], managers: [] };
    const idList = sql.join(
        wanted.map((id) => sql`${id}`),
        sql`, `,
    );
    try {
        const withManager = await hasReportsToColumn();
        const rows = (await db.execute(
            withManager
                ? sql`
                    SELECT u.id::text AS id, u.name, u.email, u.is_active,
                           m.id::text AS m_id, m.name AS m_name, m.email AS m_email, m.is_active AS m_active
                      FROM users u
                      LEFT JOIN users m ON m.id = u.reports_to
                     WHERE u.id::text IN (${idList})`
                : sql`
                    SELECT u.id::text AS id, u.name, u.email, u.is_active,
                           NULL AS m_id, NULL AS m_name, NULL AS m_email, NULL AS m_active
                      FROM users u
                     WHERE u.id::text IN (${idList})`,
        )) as unknown as Array<{
            id: string;
            name: string | null;
            email: string | null;
            is_active: boolean;
            m_id: string | null;
            m_name: string | null;
            m_email: string | null;
            m_active: boolean | null;
        }>;
        return {
            people: rows.filter((r) => r.is_active).map((r) => ({ id: r.id, name: r.name, email: r.email })),
            managers: rows
                .filter((r) => r.m_id && r.m_active)
                .map((r) => ({ id: r.m_id!, name: r.m_name, email: r.m_email })),
        };
    } catch (e) {
        console.warn("[quoteApprovalEmail] could not load people — no CC from users", e);
        return { people: [], managers: [] };
    }
}

async function loadCeoEmails(): Promise<string[]> {
    try {
        const rows = (await db.execute(sql`
            SELECT email FROM users
             WHERE role = 'ceo' AND is_active = true AND email IS NOT NULL AND email <> ''
        `)) as unknown as Array<{ email: string }>;
        return rows.map((r) => r.email);
    } catch (e) {
        console.warn("[quoteApprovalEmail] could not load CEO emails", e);
        return [];
    }
}

function esc(v: unknown): string {
    return String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Product table + totals, GST at each product's rate. No OEM price, ever. */
async function linesBlock(lines: CommercialsProductLine[]): Promise<{ html: string; text: string; total: number }> {
    const taxRefs = await loadLineTaxRefs(lines).catch(() => new Map());
    const preview = buildQuotePreview(
        lines,
        (l) => taxRefs.get(taxRefKey(l.asset_type, l.product_id))?.gstRatePct ?? DEFAULT_TAX_BY_ASSET_TYPE[l.asset_type]?.gstRatePct ?? null,
    );
    const td = 'style="padding:6px 8px;border-bottom:1px solid #e2e8f0"';
    const tdr = 'style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right"';
    const rows = preview.lines
        .map(
            ({ line, amount, gstRatePct, gst }) =>
                `<tr><td ${td}>${esc(line.product_name)}</td><td ${tdr}>${line.quantity}</td>` +
                `<td ${tdr}>${line.unit_price != null ? inr(line.unit_price) : "—"}</td>` +
                `<td ${tdr}>${amount != null ? inr(amount) : "—"}</td>` +
                `<td ${tdr}>${gst != null ? `${inr(gst)} (${gstRatePct}%)` : "—"}</td>` +
                `<td ${tdr}>${amount != null ? inr(amount + (gst ?? 0)) : "—"}</td></tr>`,
        )
        .join("");
    const th = 'style="padding:6px 8px;background:#f1f5f9;text-align:left"';
    const thr = 'style="padding:6px 8px;background:#f1f5f9;text-align:right"';
    const html =
        `<table style="border-collapse:collapse;font-size:13px;min-width:520px">` +
        `<thead><tr><th ${th}>Product</th><th ${thr}>Qty</th><th ${thr}>Unit price (ex-GST)</th><th ${thr}>Amount</th><th ${thr}>GST</th><th ${thr}>Line total</th></tr></thead>` +
        `<tbody>${rows}</tbody>` +
        `<tfoot>` +
        `<tr><td colspan="5" ${tdr}>Sub-total (ex-GST)</td><td ${tdr}>${inr(preview.subTotal)}</td></tr>` +
        `<tr><td colspan="5" ${tdr}>GST</td><td ${tdr}>${inr(preview.gstTotal)}</td></tr>` +
        `<tr><td colspan="5" ${tdr}><strong>Total incl. GST</strong></td><td ${tdr}><strong>${inr(preview.total)}</strong></td></tr>` +
        `</tfoot></table>` +
        (preview.hasUnsetGst ? `<p style="color:#b45309;font-size:12px">A product has no GST rate set — its GST is not included.</p>` : "");
    const text = [
        ...preview.lines.map(
            ({ line, amount, gst }) =>
                `- ${line.product_name} × ${line.quantity} @ ${line.unit_price != null ? inr(line.unit_price) : "—"} = ${amount != null ? inr(amount) : "—"}${gst != null ? ` + GST ${inr(gst)}` : ""}`,
        ),
        `Sub-total (ex-GST): ${inr(preview.subTotal)}`,
        `GST: ${inr(preview.gstTotal)}`,
        `Total incl. GST: ${inr(preview.total)}`,
    ].join("\n");
    return { html, text, total: preview.total };
}

export type QuoteEmailSubject = {
    /** "lead" — dealer_lead_commercials; "account" — account_quotations. */
    family: "lead" | "account";
    /** Dealer / account name as the CRM shows it. */
    dealerName: string | null;
    /** Lead id or account id, printed for reference. */
    refId: string;
    versionNo?: number | null;
    lines: CommercialsProductLine[];
    termsLabel?: string | null;
    notes?: string | null;
};

function header(s: QuoteEmailSubject): string {
    const kind = s.family === "account" ? "Account" : "Lead";
    return `${s.dealerName?.trim() || "Dealer"} (${kind} ${s.refId})${s.versionNo ? ` · v${s.versionNo}` : ""}`;
}

export type BuiltEmail = { to: string[]; cc: string[]; subject: string; html: string; text: string };

async function deliver(args: BuiltEmail): Promise<boolean> {
    if (args.to.length === 0) return false;
    try {
        await sendEmail({ to: args.to, cc: args.cc.length ? args.cc : undefined, subject: args.subject, html: args.html, text: args.text });
        return true;
    } catch (e) {
        console.error("[quoteApprovalEmail] send failed", e);
        return false;
    }
}

type ApprovalRequestInput = QuoteEmailSubject & {
    raisedBy: string;
    raisedByName?: string | null;
    reason?: string | null;
    href: string;
};

/**
 * The approval request to the CEO. Returns true when it was handed to the
 * mailer — the caller then turns emit()'s own CEO email off.
 */
export async function sendQuoteApprovalRequestEmail(p: ApprovalRequestInput): Promise<boolean> {
    try {
        return await deliver(await buildQuoteApprovalRequestEmail(p));
    } catch (e) {
        console.error("[quoteApprovalEmail] approval request failed", e);
        return false;
    }
}

/** The approval request, built but not sent (scripts/verify-quote-approval-email.ts previews it). */
export async function buildQuoteApprovalRequestEmail(p: ApprovalRequestInput): Promise<BuiltEmail> {
    const [ceos, { people, managers }, block] = await Promise.all([
        loadCeoEmails(),
        loadPeople([p.raisedBy]),
        linesBlock(p.lines),
    ]);
    const raiser = people[0];
    const raiserName = raiser?.name?.trim() || p.raisedByName?.trim() || "A salesperson";
    const { to, cc } = splitRecipients(ceos, [raiser?.email, ...managers.map((m) => m.email), ...careCcEmails()]);
    const link = `${APP_URL()}${p.href}`;
    const title = `Quotation approval needed — ${header(p)}`;
    const html =
        `<p><strong>${esc(raiserName)}</strong> raised a quotation for <strong>${esc(header(p))}</strong> that needs your approval.</p>` +
        (p.reason?.trim() ? `<p>Why it needs approval: ${esc(p.reason.trim())}.</p>` : "") +
        block.html +
        (p.termsLabel ? `<p>Payment terms: ${esc(p.termsLabel)}</p>` : "") +
        (p.notes?.trim() ? `<p>Notes: ${esc(p.notes.trim())}</p>` : "") +
        `<p>The dealer sees nothing until it is approved.</p>` +
        `<p><a href="${esc(link)}">Approve or reject in iTarang →</a></p>`;
    const text = [
        `${raiserName} raised a quotation for ${header(p)} that needs your approval.`,
        p.reason?.trim() ? `Why it needs approval: ${p.reason.trim()}.` : "",
        "",
        block.text,
        p.termsLabel ? `Payment terms: ${p.termsLabel}` : "",
        p.notes?.trim() ? `Notes: ${p.notes.trim()}` : "",
        "",
        `Approve or reject: ${link}`,
    ]
        .filter((x) => x !== "")
        .join("\n");
    return { to, cc, subject: `[iTarang] ${title}`, html, text };
}

type ApprovedInput = QuoteEmailSubject & {
    raisedBy: string | null;
    ownerId: string | null;
    approverName?: string | null;
    quoteNumber: string | null;
    draftReady: boolean;
    href: string;
};

/**
 * The CEO approved it: tell the salesperson and the owner, copy their
 * managers and care@. Returns the user ids it reached, so the caller can turn
 * emit()'s duplicate email off for exactly them.
 */
export async function sendQuoteApprovedEmail(p: ApprovedInput): Promise<string[]> {
    try {
        const built = await buildQuoteApprovedEmail(p);
        return (await deliver(built)) ? built.userIds : [];
    } catch (e) {
        console.error("[quoteApprovalEmail] approved email failed", e);
        return [];
    }
}

/** The approved email, built but not sent, plus the user ids it addresses. */
export async function buildQuoteApprovedEmail(p: ApprovedInput): Promise<BuiltEmail & { userIds: string[] }> {
    const [{ people, managers }, block] = await Promise.all([loadPeople([p.raisedBy, p.ownerId]), linesBlock(p.lines)]);
    const withEmail = people.filter((x) => !!x.email);
    const { to, cc } = splitRecipients(
        withEmail.map((x) => x.email),
        [...managers.map((m) => m.email), ...careCcEmails()],
    );
    const link = `${APP_URL()}${p.href}`;
    const ref = p.quoteNumber ? ` ${p.quoteNumber}` : "";
    const title = `Quotation${ref} approved — ${header(p)}`;
    const next = p.draftReady
        ? "The quotation document is ready — send it to the dealer from the CRM."
        : "The document could not be generated — open the quotation and retry before sending.";
    const html =
        `<p>The quotation${esc(ref)} for <strong>${esc(header(p))}</strong> was approved by <strong>${esc(p.approverName?.trim() || "the CEO")}</strong>.</p>` +
        block.html +
        (p.termsLabel ? `<p>Payment terms: ${esc(p.termsLabel)}</p>` : "") +
        `<p>${esc(next)}</p>` +
        `<p><a href="${esc(link)}">Open in iTarang →</a></p>`;
    const text = [
        `The quotation${ref} for ${header(p)} was approved by ${p.approverName?.trim() || "the CEO"}.`,
        "",
        block.text,
        p.termsLabel ? `Payment terms: ${p.termsLabel}` : "",
        "",
        next,
        link,
    ]
        .filter((x, i, a) => !(x === "" && a[i - 1] === ""))
        .join("\n");
    return { to, cc, subject: `[iTarang] ${title}`, html, text, userIds: withEmail.map((x) => x.id) };
}

/** "Cash" / "Credit — 30 days" for the email body. */
export function termsLabel(t: { dealer_payment_terms?: string | null; credit_days?: number | null }): string | null {
    if (t.dealer_payment_terms === "credit") return `Credit — ${t.credit_days ?? "?"} days`;
    if (t.dealer_payment_terms === "cash") return "Cash";
    return null;
}
