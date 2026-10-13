// Who may open a stored file (tracker ID 166, decided 10 Oct).
//
// The rule: Admin, the Sales Head, the CEO, or the owner of the lead or
// account. On top of that:
//   - a dealer opens only the files of its own customers / its own onboarding;
//   - an NBFC opens only the files of applications shared with it;
//   - expense bills and scanned invoices: Finance, Admin, CEO and the person
//     who submitted the expense (the Sales Head does NOT see them);
//   - call recordings follow the lead rule (an AI reviewer runs on the server
//     and needs no login).
//
// This module is the pure half: what kind of file a storage key is, and the
// decision once the facts about that file are known. fileAuthz.ts loads the
// facts from the database. No db or env imports here, so it unit-tests alone.

export type FileKind =
    /** Customer lead (leads.id) KYC, consent, pre-sanction docs, product photos. */
    | { kind: "customer_lead"; leadId: string; kyc: true }
    /** Dealer lead (dealer_leads.id): WhatsApp screenshots, attached call recordings. */
    | { kind: "dealer_lead"; dealerLeadId: string }
    /** Bolna / ElevenLabs recording; the lead is found from the call row. */
    | { kind: "provider_recording" }
    | { kind: "expense_bill"; submitterId: string }
    | { kind: "sales_invoice_scan" }
    | { kind: "account"; accountId: string }
    /** Dealer onboarding upload (web form or WhatsApp) — found by its file row. */
    | { kind: "dealer_onboarding"; applicationId: string | null }
    /** Signed / unsigned dealer agreement or audit trail. */
    | { kind: "dealer_agreement"; applicationId: string | null }
    /** The agreement template: internal staff only. */
    | { kind: "agreement_template" }
    /** Dealer Aadhaar autofill scans (shown through a 15-minute signed link). */
    | { kind: "autofill_scan" }
    | { kind: "assistant_media"; userId: string }
    /**
     * Not personal documents (auction / refurb / recovery photos, quotations,
     * feature-request attachments, buyback evidence, visit photos): any
     * signed-in user, as before ID 166.
     */
    | { kind: "operational" }
    /** A folder this rule does not know: the top roles only. */
    | { kind: "unknown" };

/** The roles that open every file except bills and invoice scans. */
export const FILE_TOP_ROLES = ["admin", "ceo", "sales_head"] as const;
/** Bills and scanned invoices (ID 166 Q3; there is no Finance login yet). */
export const FINANCE_FILE_ROLES = ["admin", "ceo", "finance_controller"] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OPERATIONAL_DOCUMENT_PREFIXES = new Set([
    "auction",
    "refurb",
    "recovery",
    "quotations",
    "feature-requests",
]);

const OPERATIONAL_DEALER_DOCUMENT_PREFIXES = new Set(["buyback", "commercials", "visit-photos"]);

const AGREEMENT_PREFIXES = new Set(["agreements", "dealer-signed-agreement-upload"]);
const AGREEMENT_FILE = /^(?:signed-agreement|audit-trail|unsigned-agreement)\.pdf$/i;

/**
 * What a stored file is, from its logical bucket and key alone. Keys come from
 * the uploaders (kyc/<leadId>/…, expenses/<userId>/…, attached/<leadId>/…);
 * anything not recognised in `documents` / `call-recordings` is treated as the
 * strictest kind that still lets the top roles open it.
 */
export function classifyFile(bucket: string, key: string): FileKind {
    const parts = key.split("/").filter(Boolean);
    const [first = "", second = ""] = parts;
    const top = first.toLowerCase();

    if (bucket === "call-recordings") {
        // attached/<dealer lead id>/<recording id>.<ext> (recordingKeyFor);
        // <prefix?>/<provider>/<call id>.<ext> (recordingStore).
        const at = parts.findIndex((p) => p.toLowerCase() === "attached");
        if (at !== -1 && parts[at + 1]) return { kind: "dealer_lead", dealerLeadId: parts[at + 1] };
        return { kind: "provider_recording" };
    }

    if (bucket === "dealer-documents") {
        if (top === "agreement-template-file") return { kind: "agreement_template" };
        if (OPERATIONAL_DEALER_DOCUMENT_PREFIXES.has(top)) return { kind: "operational" };
        if (AGREEMENT_PREFIXES.has(top)) {
            return { kind: "dealer_agreement", applicationId: UUID.test(second) ? second : null };
        }
        if (AGREEMENT_FILE.test(parts[parts.length - 1] ?? "") || top === "signed-agreement.pdf") {
            return { kind: "dealer_agreement", applicationId: UUID.test(first) ? first : null };
        }
        // Everything else is an onboarding upload: <document type>/<file>.
        return { kind: "dealer_onboarding", applicationId: null };
    }

    // `documents`
    if ((top === "kyc" || top === "leads") && second) {
        return { kind: "customer_lead", leadId: second, kyc: true };
    }
    if (top === "whatsapp-screenshots" && second) return { kind: "dealer_lead", dealerLeadId: second };
    if (top === "expenses" && second) return { kind: "expense_bill", submitterId: second };
    if (top === "sales") return { kind: "sales_invoice_scan" };
    if (top === "accounts" && second) return { kind: "account", accountId: second };
    if (top === "onboarding" && second) {
        return { kind: "dealer_onboarding", applicationId: UUID.test(second) ? second : null };
    }
    if (top === "whatsapp") {
        // whatsapp/<application id>/… for WhatsApp dealer onboarding; other
        // shapes are resolved by the file row.
        return { kind: "dealer_onboarding", applicationId: UUID.test(second) ? second : null };
    }
    if (top === "autofill") return { kind: "autofill_scan" };
    if (top === "wa-assistant" && second) return { kind: "assistant_media", userId: second };
    if (OPERATIONAL_DOCUMENT_PREFIXES.has(top)) return { kind: "operational" };
    // Unknown folder: top roles only. Logged by the route so a missed folder
    // shows up instead of silently opening.
    return { kind: "unknown" };
}

/** Is this a KYC file whose every open is logged (ID 166 point 4)? */
export function isKycFile(kind: FileKind): boolean {
    return kind.kind === "customer_lead";
}

export type FileViewer = {
    id: string;
    role: string;
    /** Dealer code (users.dealer_id, or the onboarding application's). */
    dealerCode: string | null;
    /** NBFC tenants this login belongs to (nbfc_users). */
    nbfcTenantIds: readonly string[];
};

/** What the database says about the file; only what the kind needs is filled. */
export type FileFacts = {
    /** Customer lead: leads.dealer_id (a dealer code / account id). */
    leadDealerId?: string | null;
    leadUploaderId?: string | null;
    /** NBFC tenants the customer lead is shared with (nbfc_lead_assignments). */
    sharedTenantIds?: readonly string[];
    /** Owners on the dealer lead: current owner and ASM. */
    dealerLeadOwnerIds?: readonly (string | null)[];
    /** iTarang owner of the account the file belongs to. */
    accountOwnerId?: string | null;
    /** The dealer login that owns the onboarding application. */
    applicationDealerUserId?: string | null;
};

const INTERNAL_EXCLUDED = new Set(["dealer", "nbfc_partner", "user", ""]);

function has(list: readonly string[], role: string): boolean {
    return list.includes(role);
}

/**
 * The decision. `facts` must already hold what the kind needs (fileAuthz.ts);
 * a missing fact is a refusal, never a pass.
 */
export function mayOpenFile(viewer: FileViewer, file: FileKind, facts: FileFacts = {}): boolean {
    const role = (viewer.role ?? "").toLowerCase();
    const top = has(FILE_TOP_ROLES, role);
    const ownsAccount = !!facts.accountOwnerId && facts.accountOwnerId === viewer.id;

    switch (file.kind) {
        case "operational":
            return true;
        case "expense_bill":
            return has(FINANCE_FILE_ROLES, role) || file.submitterId === viewer.id;
        case "sales_invoice_scan":
            return has(FINANCE_FILE_ROLES, role);
        case "agreement_template":
            return !INTERNAL_EXCLUDED.has(role);
        case "autofill_scan":
            return top;
        case "assistant_media":
            return top || file.userId === viewer.id;
        case "customer_lead": {
            if (top || ownsAccount) return true;
            if (facts.leadUploaderId && facts.leadUploaderId === viewer.id) return true;
            if (role === "dealer") {
                const lead = (facts.leadDealerId ?? "").trim();
                const mine = (viewer.dealerCode ?? "").trim();
                return !!lead && !!mine && lead === mine;
            }
            const shared = facts.sharedTenantIds ?? [];
            return viewer.nbfcTenantIds.some((t) => shared.includes(t));
        }
        case "dealer_lead":
        case "provider_recording":
            if (top) return true;
            return (facts.dealerLeadOwnerIds ?? []).some((o) => !!o && o === viewer.id);
        case "account":
            return top || ownsAccount;
        case "dealer_onboarding":
        case "dealer_agreement":
            if (top || ownsAccount) return true;
            return !!facts.applicationDealerUserId && facts.applicationDealerUserId === viewer.id;
        case "unknown":
            return top;
    }
}
