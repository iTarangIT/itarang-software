// Who may open a stored file (tracker ID 166, decided 10 Oct).
//
// The rule: Admin, the Sales Head, the CEO, or the owner of the lead or
// account. On top of that:
//   - a dealer opens only the files of its own customers / its own onboarding,
//     and on a customer's application only the files it uploaded itself
//     (16 Oct, E-349 — dealerUploadedFile);
//   - an NBFC opens only the files of applications shared with it;
//   - expense bills and scanned invoices: Finance, Admin, CEO and the person
//     who submitted the expense (the Sales Head does NOT see them);
//   - call recordings follow the lead rule (an AI reviewer runs on the server
//     and needs no login).
//
// 16 Oct (15 Oct check): the folders that were still open to any login now have
// owners too — quotations, commercials and visit photos (the dealer lead's
// owner / ASM), buyback (buyback staff + the requesting dealer), feature
// requests (seat holders), auction / refurbishment / recovery photos (the NBFC
// that owns them, the refurbisher on the lot, an auction's dealer audience) —
// and the NBFC store behind /api/nbfc-uploads follows the same rule: the NBFC
// for its own cases and the applications shared with it.
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
     * A dealer lead's quotation PDF, commercials attachment (quote document,
     * brochure) or visit photo / PDF. The lead is found from the row that
     * stores the link (fileAuthz.ts); until then nobody but the top roles.
     */
    | { kind: "dealer_lead_attachment"; source: "quotation" | "commercials" | "visit" }
    /** Buyback evidence, quotations, POs: buyback staff and the requesting dealer. */
    | { kind: "buyback"; requestId: string | null }
    /** Feature-request attachments: anyone holding a feature-request seat. */
    | { kind: "feature_request" }
    /** Photos of a recovered battery (auction lots show them to their audience). */
    | { kind: "auction_battery"; batteryId: string }
    /** Refurbishment lot photos and documents. */
    | { kind: "refurb_lot"; lotId: string }
    /** A recovery agent's visit photos. */
    | { kind: "recovery_visit"; assignmentId: string }
    // ── the NBFC store (bucket nbfc-documents, served at /api/nbfc-uploads) ──
    /** Loan agreement, admin / verdict attachments of one customer lead. */
    | { kind: "nbfc_lead"; leadId: string; dealerMay: boolean }
    /** Field visit photos, video KYC recordings, EMI payment proofs of one case. */
    | { kind: "nbfc_case"; table: "fi" | "vkyc" | "emi"; id: string }
    /** Tenant-wide files: consent template, FI / recovery agent photos. */
    | { kind: "nbfc_tenant"; tenantRef: string }
    /** Onboarding papers of one NBFC (nbfc.id): compliance, LSP agreement, signer ID. */
    | { kind: "nbfc_partner_doc"; nbfcId: number; personal: boolean }
    /** A folder this rule does not know: the top roles only. */
    | { kind: "unknown" };

/** The roles that open every file except bills and invoice scans. */
export const FILE_TOP_ROLES = ["admin", "ceo", "sales_head"] as const;
/** Bills and scanned invoices (ID 166 Q3; there is no Finance login yet). */
export const FINANCE_FILE_ROLES = ["admin", "ceo", "finance_controller"] as const;
/**
 * Buyback staff. Same list as src/lib/buyback/roles.ts BUYBACK_ADMIN_ROLES —
 * restated (not imported) so this module stays free of other modules; a test
 * pins the two together.
 */
export const BUYBACK_FILE_ROLES = ["admin", "ceo", "business_head", "sales_head", "partner"] as const;

/** The logical bucket behind /api/nbfc-uploads (src/lib/nbfc/nbfc-storage.ts). */
export const NBFC_FILE_BUCKET = "nbfc-documents";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AGREEMENT_PREFIXES = new Set(["agreements", "dealer-signed-agreement-upload"]);
const AGREEMENT_FILE = /^(?:signed-agreement|audit-trail|unsigned-agreement)\.pdf$/i;

/**
 * The NBFC store's key layout, from its uploaders:
 *   agreements/<leadId>/…               loan agreement + audit trail
 *   admin-attachments/<leadId>/…        admin → NBFC document requests
 *   verdict-attachments/<leadId>/…      NBFC verdict attachments
 *   fi/<fieldInvestigationId>/…         field visit photos
 *   vkyc/<videoKycId>/liveness-…        video KYC recordings
 *   emi-receipts/<loanSanctionId>/…     EMI payment proofs
 *   fi-agents/<tenant, no dashes>/…     FI agent reference photos
 *   recovery-agents/<tenant, no dashes>/…
 *   <tenantId>/consent-template/…       the NBFC's own consent form
 *   <nbfc.id>/signer-identity/…         signer ID papers (personal)
 *   <nbfc.id>/agreement-template|lsp-agreement/…, <nbfc.id>/<file>  compliance
 */
function classifyNbfcFile(parts: string[]): FileKind {
    const [first = "", second = ""] = parts;
    const top = first.toLowerCase();
    if (!second) return { kind: "unknown" };
    if (top === "agreements") return { kind: "nbfc_lead", leadId: second, dealerMay: true };
    if (top === "admin-attachments" || top === "verdict-attachments") {
        return { kind: "nbfc_lead", leadId: second, dealerMay: false };
    }
    if (top === "fi") return { kind: "nbfc_case", table: "fi", id: second };
    if (top === "vkyc") return { kind: "nbfc_case", table: "vkyc", id: second };
    if (top === "emi-receipts") return { kind: "nbfc_case", table: "emi", id: second };
    if (top === "fi-agents" || top === "recovery-agents") return { kind: "nbfc_tenant", tenantRef: second };
    if (UUID.test(first)) return { kind: "nbfc_tenant", tenantRef: first };
    if (/^\d{1,9}$/.test(first)) {
        return { kind: "nbfc_partner_doc", nbfcId: Number(first), personal: second.toLowerCase() === "signer-identity" };
    }
    return { kind: "unknown" };
}

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

    if (bucket === NBFC_FILE_BUCKET) return classifyNbfcFile(parts);

    if (bucket === "call-recordings") {
        // attached/<dealer lead id>/<recording id>.<ext> (recordingKeyFor);
        // <prefix?>/<provider>/<call id>.<ext> (recordingStore).
        const at = parts.findIndex((p) => p.toLowerCase() === "attached");
        if (at !== -1 && parts[at + 1]) return { kind: "dealer_lead", dealerLeadId: parts[at + 1] };
        return { kind: "provider_recording" };
    }

    if (bucket === "dealer-documents") {
        if (top === "agreement-template-file") return { kind: "agreement_template" };
        // buyback/<request id>/… (src/lib/buyback/storage.ts); statements and
        // vendor staging files carry no request: buyback staff only.
        if (top === "buyback") return { kind: "buyback", requestId: UUID.test(second) ? second : null };
        // Uploaded through the dealer-documents form by inside sales / the ASM.
        if (top === "commercials") return { kind: "dealer_lead_attachment", source: "commercials" };
        if (top === "visit-photos") return { kind: "dealer_lead_attachment", source: "visit" };
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
    if (top === "quotations") return { kind: "dealer_lead_attachment", source: "quotation" };
    if (top === "feature-requests") return { kind: "feature_request" };
    // auction/batteries/<battery id>/…, refurb/lots/<lot id>/…, recovery/<assignment id>/…
    const third = parts[2] ?? "";
    if (top === "auction" && second === "batteries" && third) return { kind: "auction_battery", batteryId: third };
    if (top === "refurb" && second === "lots" && third) return { kind: "refurb_lot", lotId: third };
    if (top === "recovery" && second) return { kind: "recovery_visit", assignmentId: second };
    // Unknown folder: top roles only. Logged by the route so a missed folder
    // shows up instead of silently opening.
    return { kind: "unknown" };
}

/** Is this a KYC file whose every open is logged (ID 166 point 4)? */
export function isKycFile(kind: FileKind): boolean {
    return kind.kind === "customer_lead";
}

/**
 * Is every open of this file written to file_access_log? Customer KYC (ID 166
 * point 4), plus the other identity papers the 15 Oct check named: a dealer's
 * own onboarding papers (PAN, Aadhaar, GST), NBFC field visit photos, video
 * KYC recordings, signer ID papers and the NBFC store's per-lead files.
 */
export function isLoggedFile(kind: FileKind): boolean {
    switch (kind.kind) {
        case "customer_lead":
        case "dealer_onboarding":
        case "nbfc_lead":
            return true;
        case "nbfc_case":
            return kind.table !== "emi";
        case "nbfc_partner_doc":
            return kind.personal;
        default:
            return false;
    }
}

/** The lead a logged open is filed under (file_access_log.lead_id), when the key names one. */
export function loggedLeadId(kind: FileKind): string | null {
    if (kind.kind === "customer_lead" || kind.kind === "nbfc_lead") return kind.leadId;
    return null;
}

export type FileViewer = {
    id: string;
    role: string;
    /** Dealer code (users.dealer_id, or the onboarding application's). */
    dealerCode: string | null;
    /** NBFC tenants this login belongs to (nbfc_users). */
    nbfcTenantIds: readonly string[];
    /** users.refurbisher_id for a refurbisher login (E-292). */
    refurbisherId?: string | null;
};

/** One row that records a customer file and who uploaded it (ID 166, E-349). */
export type FileUpload = {
    /** users.id of the uploader; null for a customer upload or an old row. */
    uploaderId: string | null;
    /** users.dealer_id of the uploader, when there is one. */
    uploaderDealerCode: string | null;
    /**
     * 'portal' | 'public_link' | 'whatsapp' | 'act_for_dealer' (ID 183);
     * null on rows from before E-349.
     */
    source: string | null;
};

/**
 * ID 166 (decided 10 Oct, 15 Oct check): a dealer opens only the files it
 * uploaded itself on its customer's application — not what the customer sent
 * through the public link, nor what Admin or the NBFC added. A file no row
 * records, or a row from before uploaders were recorded (no uploader, no
 * source), keeps the old rule: the lead's dealer opens it.
 */
export function dealerUploadedFile(viewer: FileViewer, uploads: readonly FileUpload[] | undefined): boolean {
    if (!uploads || uploads.length === 0) return true;
    return uploads.some((u) => {
        if (!u.uploaderId && !u.source) return true;
        // ID 183: Admin / Sales Head uploaded it ACTING FOR this dealer — the
        // dealer's own upload. (Called only on the dealer's own customer.)
        if (u.source === "act_for_dealer") return true;
        if (!u.uploaderId) return false;
        return u.uploaderId === viewer.id || sameDealer(viewer, u.uploaderDealerCode);
    });
}

/** What the database says about the file; only what the kind needs is filled. */
export type FileFacts = {
    /** Customer lead: leads.dealer_id (a dealer code / account id). */
    leadDealerId?: string | null;
    leadUploaderId?: string | null;
    /** Customer lead: leads.assigned_to and leads.sm_assigned_to (ID 119 owners). */
    leadAssignedTo?: string | null;
    leadSmAssignedTo?: string | null;
    /**
     * ID 166 (E-349): the KYC / co-borrower / requested-document rows that hold
     * this exact file, with who uploaded each. Loaded for a dealer viewer only;
     * undefined or empty = no row records the file (consent PDFs, photos, …).
     */
    fileUploads?: readonly FileUpload[];
    /** NBFC tenants the customer lead is shared with (nbfc_lead_assignments). */
    sharedTenantIds?: readonly string[];
    /** Owners on the dealer lead: current owner and ASM. */
    dealerLeadOwnerIds?: readonly (string | null)[];
    /** iTarang owner of the account the file belongs to. */
    accountOwnerId?: string | null;
    /** The dealer login that owns the onboarding application. */
    applicationDealerUserId?: string | null;
    /** Buyback: buyback_requests.dealer_entity_id (the dealer's account id). */
    buybackDealerId?: string | null;
    /** Feature requests: the viewer holds an active seat. */
    hasFeatureSeat?: boolean;
    /** NBFC tenants that own the object (the case's / battery's / lot's tenant). */
    ownerTenantIds?: readonly string[];
    /** Auction battery: dealer codes in the audience of a lot it is on. */
    audienceDealerIds?: readonly string[];
    /** Refurbishment lot: the refurbisher it is assigned to. */
    refurbisherId?: string | null;
};

const INTERNAL_EXCLUDED = new Set(["dealer", "nbfc_partner", "user", ""]);

function has(list: readonly string[], role: string): boolean {
    return list.includes(role);
}

/** Tenant ids compared without dashes or case: agent photo keys use the bare hex. */
const bareTenant = (t: string) => t.replace(/-/g, "").toLowerCase();

function inTenant(viewer: FileViewer, tenants: readonly string[] | undefined): boolean {
    const mine = new Set(viewer.nbfcTenantIds.map(bareTenant));
    return (tenants ?? []).some((t) => !!t && mine.has(bareTenant(t)));
}

function sameDealer(viewer: FileViewer, code: string | null | undefined): boolean {
    const want = (code ?? "").trim();
    const mine = (viewer.dealerCode ?? "").trim();
    return !!want && !!mine && want === mine;
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
        case "dealer_lead_attachment":
            if (top) return true;
            return (facts.dealerLeadOwnerIds ?? []).some((o) => !!o && o === viewer.id);
        case "buyback":
            if (has(BUYBACK_FILE_ROLES, role)) return true;
            return role === "dealer" && sameDealer(viewer, facts.buybackDealerId);
        case "feature_request":
            return top || facts.hasFeatureSeat === true;
        case "auction_battery":
            if (top || inTenant(viewer, facts.ownerTenantIds)) return true;
            return role === "dealer" && (facts.audienceDealerIds ?? []).some((d) => sameDealer(viewer, d));
        case "refurb_lot":
            if (top || inTenant(viewer, facts.ownerTenantIds)) return true;
            return role === "refurbisher" && !!viewer.refurbisherId && viewer.refurbisherId === facts.refurbisherId;
        case "recovery_visit":
            return top || inTenant(viewer, facts.ownerTenantIds);
        case "nbfc_lead":
            if (top || ownsAccount || inTenant(viewer, facts.sharedTenantIds)) return true;
            return file.dealerMay && role === "dealer" && sameDealer(viewer, facts.leadDealerId);
        case "nbfc_case":
            return top || ownsAccount || inTenant(viewer, facts.ownerTenantIds);
        case "nbfc_tenant":
            return top || inTenant(viewer, [file.tenantRef]);
        case "nbfc_partner_doc":
            return top || inTenant(viewer, facts.ownerTenantIds);
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
            const ownsLead = [facts.leadUploaderId, facts.leadAssignedTo, facts.leadSmAssignedTo].some(
                (o) => !!o && o === viewer.id,
            );
            if (role === "dealer") {
                // Its own customer (or a lead it uploaded), and then only the
                // files it uploaded itself (ID 166, E-349).
                const ownCustomer = ownsLead || sameDealer(viewer, facts.leadDealerId);
                return ownCustomer && dealerUploadedFile(viewer, facts.fileUploads);
            }
            // ID 119: the lead's owner is whoever uploaded it, has it assigned
            // or is its sales manager — the same rule as backOfficeOwnsLead, so
            // an owning sales manager opens the files the KYC screens show them.
            if (ownsLead) return true;
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
