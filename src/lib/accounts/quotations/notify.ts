/**
 * E-358 — notifications for ACCOUNT quotations. Same event types as the lead
 * quotation family (catalog.ts files them under Leads with the same colours),
 * but every one carries the Account ID and name, no lead id, and links to the
 * account's page in My Dealers. emit() never throws, so none of these can fail
 * the action that raised them.
 */
import { emit, type Recipient } from "@/lib/notifications/emit";
import { ADMIN_PARTY } from "@/lib/notifications/provenance";

type AccountRef = { accountId: string; accountName: string | null };

const accountLabel = (a: AccountRef) => `${a.accountName?.trim() || "a dealer account"} (${a.accountId})`;
const money = (v: number) => (v > 0 ? ` for ₹${v.toLocaleString("en-IN")}` : "");
const accountHref = (accountId: string, quotationId: string) =>
    `/my-dealers/${encodeURIComponent(accountId)}?quote=${quotationId}`;

/** The owner and whoever raised it — deduped, unset ids dropped. */
function people(ids: Array<string | null | undefined>, href: string): Recipient[] {
    return [...new Set(ids.filter((x): x is string => !!x))].map((userId) => ({
        audience: { kind: "user" as const, userId },
        as: ADMIN_PARTY,
        href,
    }));
}

export async function notifyAccountQuotationPendingApproval(
    p: AccountRef & { quotationId: string; value: number; reason?: string | null; raisedByName?: string | null },
) {
    const who = p.raisedByName?.trim() ? ` by ${p.raisedByName.trim()}` : "";
    const why = p.reason?.trim() ? ` Flagged: ${p.reason.trim()}.` : "";
    await emit({
        type: "quote.pending_approval",
        title: "Account quotation awaiting your approval",
        message: `An account quotation${money(p.value)} was raised for ${accountLabel(p)}${who} and is waiting in the approval queue.${why} The dealer sees nothing until it is approved.`,
        stage: "Account quotation",
        from: ADMIN_PARTY,
        data: { accountId: p.accountId, quotationId: p.quotationId, value: p.value, reason: p.reason ?? null, family: "account" },
        to: [{ audience: { kind: "roles" as const, roles: ["ceo", "admin"] }, as: ADMIN_PARTY, href: "/ceo/quotations" }],
    });
}

export async function notifyAccountQuotationApproved(
    p: AccountRef & {
        quotationId: string;
        ownerUserId: string | null;
        createdBy: string | null;
        quoteNumber: string | null;
        value: number;
        mode: "auto" | "manual";
        approverName?: string | null;
        draftReady: boolean;
    },
) {
    const ref = p.quoteNumber ? ` (${p.quoteNumber})` : "";
    const how =
        p.mode === "auto"
            ? "auto-approved — every line was at or above its OEM reference price"
            : `approved by ${p.approverName?.trim() || "the CEO"}`;
    const tail = p.draftReady
        ? "It is ready to send to the account's email or WhatsApp."
        : "The document could not be generated — open the quotation and retry before sending.";
    await emit({
        type: "quote.approved",
        title: "Account quotation approved",
        message: `The quotation for ${accountLabel(p)}${money(p.value)}${ref} was ${how}. ${tail}`,
        stage: "Account quotation",
        from: ADMIN_PARTY,
        data: { accountId: p.accountId, quotationId: p.quotationId, quoteNumber: p.quoteNumber, mode: p.mode, family: "account" },
        to: people([p.ownerUserId, p.createdBy], accountHref(p.accountId, p.quotationId)),
    });
}

export async function notifyAccountQuotationRejected(
    p: AccountRef & {
        quotationId: string;
        ownerUserId: string | null;
        createdBy: string | null;
        versionNo: number;
        value: number;
        reason: string;
        rejectorName?: string | null;
    },
) {
    await emit({
        type: "quote.rejected",
        title: "Account quotation rejected",
        message: `${p.rejectorName?.trim() || "The CEO"} rejected v${p.versionNo} of the quotation for ${accountLabel(p)}${money(p.value)}: ${p.reason}. Revise it or talk to the dealer.`,
        stage: "Account quotation",
        from: ADMIN_PARTY,
        data: { accountId: p.accountId, quotationId: p.quotationId, reason: p.reason, family: "account" },
        to: people([p.ownerUserId, p.createdBy], accountHref(p.accountId, p.quotationId)),
    });
}

export async function notifyAccountQuotationDealerDecision(
    p: AccountRef & {
        quotationId: string;
        ownerUserId: string | null;
        createdBy: string | null;
        quoteNumber: string | null;
        value: number;
        decision: "approved" | "declined";
        via: "link" | "whatsapp";
        note?: string | null;
    },
) {
    const ref = p.quoteNumber ? ` ${p.quoteNumber}` : "";
    const channel = p.via === "whatsapp" ? "over WhatsApp" : "via the approval link";
    const note = p.note?.trim() ? ` They said: "${p.note.trim()}".` : "";
    await emit({
        type: "quote.dealer_decision",
        title: p.decision === "approved" ? "Account approved a quotation" : "Account declined a quotation",
        message: `${accountLabel(p)} ${p.decision} quotation${ref}${money(p.value)} ${channel}.${note}`,
        stage: "Account quotation",
        from: ADMIN_PARTY,
        data: { accountId: p.accountId, quotationId: p.quotationId, decision: p.decision, via: p.via, family: "account" },
        to: people([p.ownerUserId, p.createdBy], accountHref(p.accountId, p.quotationId)),
    });
}
