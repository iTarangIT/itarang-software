// Who may do what on an Ecofy lead inside the CRM (E-307).
//
// Mirrors Ecofy's own split (src/core/auth/rbac.ts in the Ecofy repo):
//   Sales Head      = iTarang Admin  — every action, on every Ecofy lead.
//   ASM / ISR       = iTarang Caller — lead work only, and only on leads the
//                     Sales Head assigned to them.
// Stage rules follow Ecofy's StepPanel. They are UI hints and a first gate;
// Ecofy re-checks every gate itself and answers GATE_NOT_MET when one fails.
//
// Pure: no DB, no env. Imported by API routes AND client components.

// The CEO may open every /sales-head page (middleware), so the CEO works the
// Ecofy workspace with Sales Head rights too. Manager NOTIFICATIONS go to the
// Sales Head only (ECOFY_NOTIFY_MANAGER_ROLES) — the CEO's bell is not a queue.
export const ECOFY_MANAGER_ROLES = ["sales_head", "ceo"] as const;
export const ECOFY_NOTIFY_MANAGER_ROLES = ["sales_head"] as const;
export const ECOFY_WORKER_ROLES = ["asm", "inside_sales_rep"] as const;
export const ECOFY_ALL_ROLES = [...ECOFY_MANAGER_ROLES, ...ECOFY_WORKER_ROLES] as const;

// Ecofy never learns WHICH CRM person handles a lead: the Sales Head decides in
// the CRM alone (ecofy_leads.assigned_to_user_id) and Ecofy only needs to know
// that iTarang took the case. Every signed call and every §4 event therefore
// carries these fixed labels — never a user's name — so Ecofy's audit log and
// case remarks read "iTarang CRM" / "iTarang team". CRM-side records
// (ecofy_lead_assignments, ecofy_lead_activities, notifications) keep the real
// names; they never leave the CRM.
export const ECOFY_OUTBOUND_ACTOR = "iTarang CRM";
export const ECOFY_OUTBOUND_ASSIGNEE = "iTarang team";

export type EcofyViewerKind = "manager" | "worker";

export function ecofyViewerKind(role: string | null | undefined): EcofyViewerKind | null {
    const r = (role ?? "").toLowerCase();
    if ((ECOFY_MANAGER_ROLES as readonly string[]).includes(r)) return "manager";
    if ((ECOFY_WORKER_ROLES as readonly string[]).includes(r)) return "worker";
    return null;
}

export const ECOFY_ROLE_LABEL: Record<string, string> = {
    sales_head: "Sales Head",
    ceo: "CEO",
    asm: "ASM",
    inside_sales_rep: "ISR",
};

/** Where each role opens an Ecofy lead. Used for links and notification hrefs. */
export function ecofyLeadHref(role: string | null | undefined, leadId: string): string {
    switch ((role ?? "").toLowerCase()) {
        case "asm":
            return `/asm/ecofy-leads/${leadId}`;
        case "inside_sales_rep":
            return `/inside-sales/ecofy-leads/${leadId}`;
        default:
            return `/sales-head/ecofy/leads/${leadId}`;
    }
}

export const ECOFY_ACTIONS = [
    // lead work — Sales Head and the assigned ASM / ISR
    "log_activity",
    "book_appointment",
    "update_appointment",
    "advance",
    "save_assessment",
    "confirm_assessment",
    "request_eligibility",
    "quote_request",
    "update_quote_request",
    "upload_quote",
    "compose_offer",
    "send_otp",
    "verify_otp",
    "create_installation",
    "update_installation",
    "request_withdrawal",
    "upload_document",
    "close",
    // Sales Head only (iTarang Admin in Ecofy)
    "assign",
    "return",
    "reopen",
    "route_financier",
    "eligibility_decision",
    "financing_decision",
    "down_payment",
    "disbursement",
    "withdrawal_confirm",
    "withdrawal_reject",
    "withdrawal_epc_informed",
    "delete_document",
] as const;

export type EcofyAction = (typeof ECOFY_ACTIONS)[number];

const MANAGER_ONLY = new Set<EcofyAction>([
    "assign",
    "return",
    "reopen",
    "route_financier",
    "eligibility_decision",
    "financing_decision",
    "down_payment",
    "disbursement",
    "withdrawal_confirm",
    "withdrawal_reject",
    "withdrawal_epc_informed",
    "delete_document",
]);

const OPEN = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"];

/** Stages at which Ecofy accepts each action (null = any stage). */
const STAGES: Record<EcofyAction, string[] | null> = {
    log_activity: [...OPEN],
    book_appointment: [...OPEN],
    update_appointment: [...OPEN],
    advance: ["S2"],
    save_assessment: [...OPEN],
    confirm_assessment: ["S3"],
    request_eligibility: ["S4"],
    quote_request: ["S3", "S4"],
    update_quote_request: ["S3", "S4"],
    upload_quote: ["S4"],
    compose_offer: ["S4"],
    send_otp: ["S4", "S5"],
    verify_otp: ["S5", "S6"], // S6 = re-acceptance OTP (sanction below the accepted total)
    create_installation: ["S6", "S7"],
    update_installation: ["S6", "S7", "S8"],
    request_withdrawal: ["S1", "S2", "S3", "S4", "S5", "S6", "S7"],
    upload_document: [...OPEN],
    close: ["S1", "S2", "S3", "S4"],
    assign: ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8"],
    return: ["S1", "S2"],
    reopen: ["CLOSED"],
    route_financier: ["S4", "S6"],
    eligibility_decision: ["S4"],
    financing_decision: ["S6"],
    down_payment: ["S6", "S7"],
    disbursement: ["S7"],
    withdrawal_confirm: null,
    withdrawal_reject: null,
    withdrawal_epc_informed: null,
    delete_document: null,
};

export interface EcofyActor {
    id: string;
    role: string | null | undefined;
}

export interface EcofyLeadAccessView {
    assigned_to_user_id: string | null;
    stage: string | null;
}

export type EcofyAccessResult = { ok: true } | { ok: false; status: 403 | 404 | 409; reason: string };

/** May this viewer open the lead at all? Workers see only their own leads. */
export function canViewEcofyLead(actor: EcofyActor, lead: EcofyLeadAccessView): boolean {
    const kind = ecofyViewerKind(actor.role);
    if (kind === "manager") return true;
    if (kind === "worker") return lead.assigned_to_user_id === actor.id;
    return false;
}

export function checkEcofyAction(
    actor: EcofyActor,
    lead: EcofyLeadAccessView,
    action: EcofyAction,
): EcofyAccessResult {
    const kind = ecofyViewerKind(actor.role);
    if (!kind) return { ok: false, status: 403, reason: "Your role cannot work Ecofy leads" };
    // 404, not 403, for someone else's lead: the lead is invisible to them.
    if (!canViewEcofyLead(actor, lead)) return { ok: false, status: 404, reason: "Lead not found" };
    if (kind === "worker" && MANAGER_ONLY.has(action)) {
        return { ok: false, status: 403, reason: "Only the Sales Head can do this" };
    }
    const allowed = STAGES[action];
    if (allowed && !allowed.includes(lead.stage ?? "")) {
        return {
            ok: false,
            status: 409,
            reason: `Not allowed at stage ${lead.stage ?? "unknown"}`,
        };
    }
    return { ok: true };
}

export function canDoEcofyAction(actor: EcofyActor, lead: EcofyLeadAccessView, action: EcofyAction): boolean {
    return checkEcofyAction(actor, lead, action).ok;
}

export const ECOFY_STAGE_LABELS: Record<string, string> = {
    S0: "Qualification (Ecofy)",
    S1: "Pickup queue",
    S2: "Follow-up",
    S3: "Assessment",
    S4: "Offer",
    S5: "File / OTP",
    S6: "Financing (Ecofy)",
    S7: "Installation (EPC)",
    S8: "Asset (Ecofy)",
    CLOSED: "Closed",
};

export const ECOFY_CALL_OUTCOMES = ["CONNECTED", "NO_ANSWER", "BUSY", "SWITCHED_OFF", "WRONG_NUMBER", "CALL_BACK"] as const;
export const ECOFY_RETURN_REASONS = ["WRONG_NUMBER", "NOT_INTERESTED", "WANTS_LATER", "DUPLICATE", "OUT_OF_AREA", "REQUALIFY"] as const;
export const ECOFY_CLOSURE_REASONS = [
    "NOT_INTERESTED",
    "UNREACHABLE",
    "DUPLICATE",
    "OUT_OF_AREA",
    "WITHDRAWN",
    "REJECTED_ALL_FINANCIERS",
] as const;
