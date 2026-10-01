// The CRM's side of Ecofy's REST API (docs/ECOFY_INTEGRATION.md §5, E-307).
//
// Every call is signed by callEcofyApi() and runs as Ecofy's integration user
// (ITARANG_CRM_ACTOR_EMAIL, an iTarang Admin in Ecofy). The CRM person is
// passed as X-Itarang-Actor-Name, so Ecofy's audit reads
// "itarang-crm (Priya Sharma (ASM))". Who may call what is decided BEFORE this
// module, in src/lib/ecofy/access.ts; Ecofy re-checks every gate itself.
//
// Server-only.

import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { ecofyLeads } from "@/lib/db/schema";
import { errorMessage } from "@/lib/api-utils";
import { callEcofyApi, callEcofyApiRaw, type EcofyHttpMethod } from "./api";
import {
    toAssessmentCreate,
    toEcofyEpcPartner,
    type EcofyActionInput,
    type EcofyLeadRead,
    type EcofyLookup,
    type EpcPartnerInput,
} from "./actionSchemas";
import { upsertEcofyLeadSnapshot } from "./inbound";
import {
    caseToLeadSnapshot,
    type CaseCreateInput,
    type EcofyImport,
    type EcofyImportPreview,
    type EcofyUploadTicket,
} from "./intake";
import { notifyEcofySyncFailed } from "./notify";

export class EcofyCallError extends Error {
    constructor(
        message: string,
        public status: number,
        public code?: string,
        public gate?: string,
    ) {
        super(message);
        this.name = "EcofyCallError";
    }
}

interface CallOpts {
    body?: unknown;
    query?: Record<string, string | number | boolean | null | undefined>;
    ifMatch?: number;
    idempotencyKey?: string;
    actorName?: string;
    /** For the outbound ledger. */
    ecofyCaseId?: string | null;
    ecofyLeadId?: string | null;
    /**
     * Keep this call out of ecofy_sync_events. Only for POSTs that are reads
     * in disguise (the calculator's quick estimate, which Ecofy never stores);
     * every real write stays in the ledger.
     */
    skipLedger?: boolean;
}

function friendly(status: number, code?: string, gate?: string, message?: string): string {
    if (status === 409 && code === "VERSION_CONFLICT") return "This lead changed in Ecofy since you opened it — refresh and try again.";
    if (status === 412 || code === "PRECONDITION_FAILED") return "This lead changed in Ecofy since you opened it — refresh and try again.";
    if (status === 403) return message || "Ecofy refused this action for the integration user (it must be an ACTIVE iTarang Admin in Ecofy).";
    if (status === 404) return message || "Not found in Ecofy.";
    const base = message || `Ecofy answered ${status}`;
    return gate ? `${base} (gate: ${gate})` : base;
}

/** One Ecofy call. Throws EcofyCallError on a non-2xx; returns `data` from the envelope. */
export async function ecofyCall<T = unknown>(method: EcofyHttpMethod, path: string, opts: CallOpts = {}): Promise<T> {
    const mutating = method !== "GET" && !opts.skipLedger;
    let res;
    try {
        res = await callEcofyApi<T>({
            method,
            path,
            query: opts.query,
            body: opts.body,
            ifMatch: opts.ifMatch,
            idempotencyKey: opts.idempotencyKey,
            actorName: opts.actorName,
        });
    } catch (err) {
        if (mutating) await logOutbound(method, path, opts, null, null, errorMessage(err));
        void notifyEcofySyncFailed({ kind: "Ecofy unreachable", detail: errorMessage(err), leadId: opts.ecofyLeadId });
        throw new EcofyCallError(`Could not reach Ecofy: ${errorMessage(err)}`, 502);
    }
    if (mutating) {
        await logOutbound(method, path, opts, res.status, res.ok ? res.data : res.error, res.ok ? null : res.error?.message ?? null);
    }
    if (res.status >= 500) {
        void notifyEcofySyncFailed({
            kind: `Ecofy API ${res.status}`,
            detail: `${method} ${path}: ${res.error?.message ?? "server error"}`,
            leadId: opts.ecofyLeadId,
        });
    }
    if (!res.ok) {
        const code = typeof res.error?.code === "string" ? res.error.code : undefined;
        const gate = typeof res.error?.gate === "string" ? res.error.gate : undefined;
        throw new EcofyCallError(friendly(res.status, code, gate, res.error?.message), res.status, code, gate);
    }
    return res.data as T;
}

/** Mutating calls land in ecofy_sync_events (direction 'outbound') for the audit trail. */
async function logOutbound(
    method: string,
    path: string,
    opts: CallOpts,
    status: number | null,
    response: unknown,
    error: string | null,
): Promise<void> {
    // event_type is varchar(60): keep ids out of it so it stays short and groupable.
    const template = path.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ":id").replace(/\/\d+(?=\/|$)/g, "/:n");
    const eventType = `api:${method} ${template}`.slice(0, 60);
    // Sandbox Ecofy (OTP_DEV_ECHO) echoes the plaintext OTP as devCode; never persist it in the ledger.
    if (response && typeof response === "object" && "devCode" in response) {
        response = Object.fromEntries(Object.entries(response).filter(([k]) => k !== "devCode"));
    }
    try {
        await db.execute(sql`
            INSERT INTO ecofy_sync_events
                (direction, event_id, event_type, ecofy_case_id, ecofy_lead_id, payload, response, http_status, error)
            VALUES ('outbound', ${`crm-api-${randomUUID()}`}, ${eventType}, ${opts.ecofyCaseId ?? null},
                    ${opts.ecofyLeadId ?? null}::uuid,
                    ${JSON.stringify({ method, path, body: opts.body ?? null, actorName: opts.actorName ?? null })}::jsonb,
                    ${JSON.stringify(response ?? null)}::jsonb, ${status}, ${error})
        `);
    } catch (err) {
        console.error("[Ecofy/api] ledger write failed:", errorMessage(err));
    }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const READ_PATHS: Record<EcofyLeadRead, (caseId: string) => string> = {
    case: (c) => `/cases/${c}`,
    timeline: (c) => `/cases/${c}/timeline`,
    activities: (c) => `/cases/${c}/activities`,
    appointments: (c) => `/cases/${c}/appointments`,
    assessments: (c) => `/cases/${c}/assessments`,
    quotes: (c) => `/cases/${c}/quotes`,
    offers: (c) => `/cases/${c}/offers`,
    file: (c) => `/cases/${c}/file`,
    decisions: (c) => `/cases/${c}/financing/decisions`,
    "payment-status": (c) => `/cases/${c}/payment-status`,
    "down-payment": (c) => `/cases/${c}/down-payment`,
    installation: (c) => `/cases/${c}/installation`,
    withdrawals: (c) => `/cases/${c}/withdrawals`,
    documents: (c) => `/cases/${c}/documents`,
    // live re-acceptance OTP challenge (S6, sanction below accepted total) — null when none is SENT
    reacceptance: (c) => `/cases/${c}/reacceptance`,
};

export function readLeadData(ecofyCaseId: string, what: EcofyLeadRead): Promise<unknown> {
    return ecofyCall("GET", READ_PATHS[what](ecofyCaseId));
}

const lookupCache = new Map<string, { at: number; data: unknown }>();
const LOOKUP_TTL_MS = 5 * 60 * 1000;

/** Dropdown contents (lists, EPC partners, financiers) — cached 5 minutes per process. */
export async function readLookup(what: EcofyLookup): Promise<unknown> {
    const hit = lookupCache.get(what);
    if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.data;
    const data =
        what === "epc-partners"
            ? await ecofyCall("GET", "/epc-partners", { query: { limit: 100 } })
            : what === "financiers"
              ? await ecofyCall("GET", "/financiers", { query: { limit: 100 } })
              : await ecofyCall("GET", `/lists/${what}/items`, { query: { active: true } });
    lookupCache.set(what, { at: Date.now(), data });
    return data;
}

/** One EPC partner as Ecofy returns it (epcOut in m02-settings/service.ts). */
export interface EcofyEpcPartner {
    id: string;
    name: string;
    contactName: string | null;
    mobile: string | null;
    email: string | null;
    pincodes: string[];
    segments: string[];
    active: boolean;
    createdAt?: string;
}

/**
 * Add an EPC partner ("EPC agent") to Ecofy's master (POST /epc-partners,
 * iTarang Admin). The lookup cache is dropped so the new partner shows in the
 * pickers right away.
 */
export async function createEpcPartner(input: EpcPartnerInput, actorName: string): Promise<EcofyEpcPartner> {
    const created = await ecofyCall<EcofyEpcPartner>("POST", "/epc-partners", {
        body: toEcofyEpcPartner(input),
        idempotencyKey: randomUUID(),
        actorName,
    });
    lookupCache.delete("epc-partners");
    return created;
}

export type EcofyQueueKind = "eligibility" | "financing" | "assets";
const QUEUE_PATHS: Record<EcofyQueueKind, string> = {
    eligibility: "/eligibility-queue",
    financing: "/financing-queue",
    assets: "/assets",
};

/**
 * The eligibility and financing queues declare cursor/limit (OpenAPI
 * get_eligibility_queue / get_financing_queue); GET /assets declares no
 * parameters at all, so nothing is sent and the page shows exactly what Ecofy
 * returns.
 */
export function readQueue(kind: EcofyQueueKind): Promise<unknown> {
    return ecofyCall("GET", QUEUE_PATHS[kind], kind === "assets" ? {} : { query: { limit: 100 } });
}

/** GET /assets/{assetId} — asset detail (ECOFY_ADMIN / ITARANG_ADMIN read; writes are Ecofy Admin only). */
export function readAsset(assetId: string): Promise<Record<string, unknown> | null> {
    return ecofyCall<Record<string, unknown> | null>("GET", `/assets/${encodeURIComponent(assetId)}`);
}

export async function readDashboards(): Promise<{ funnel: unknown; ageing: unknown }> {
    const [funnel, ageing] = await Promise.all([
        ecofyCall("GET", "/dashboards/funnel"),
        ecofyCall("GET", "/dashboards/ageing"),
    ]);
    return { funnel, ageing };
}

export function documentDownloadUrl(documentId: string): Promise<{ url: string }> {
    return ecofyCall<{ url: string }>("GET", `/documents/${documentId}/download-url`);
}

// ---------------------------------------------------------------------------
// Energy calculator (Ecofy M07/M08). The formula and every value in it live in
// Ecofy's PUBLISHED calculator release; the CRM only renders the inputs and
// shows what Ecofy computes. Quick estimates are never stored anywhere.
// ---------------------------------------------------------------------------

export interface EcofyCalculatorRelease {
    id: string;
    version: number;
    appliances: Array<{ name: string; defaultWatts: number; isMotor: boolean }>;
    /** Per segment: whether the calculator runs and which input methods it offers. */
    segments: Record<string, { enabled: boolean; inputs?: string[] }>;
}

type ReleaseListRow = { id: string; version: number; status: string };
type ReleaseBundle = ReleaseListRow & {
    appliances?: Array<{ name: string; defaultWatts: number; isMotor: boolean; active?: boolean }>;
    params?: { segments?: Record<string, { enabled: boolean; inputs?: string[] }> };
};

let releaseCache: { at: number; data: EcofyCalculatorRelease } | null = null;
const RELEASE_TTL_MS = 5 * 60 * 1000;

/** The published calculator release (appliance catalogue + segment inputs) — cached 5 minutes per process. */
export async function readCalculatorRelease(): Promise<EcofyCalculatorRelease> {
    if (releaseCache && Date.now() - releaseCache.at < RELEASE_TTL_MS) return releaseCache.data;
    const list = (await ecofyCall<ReleaseListRow[]>("GET", "/calculator/releases")) ?? [];
    const pub = list.find((r) => r.status === "PUBLISHED");
    if (!pub) throw new EcofyCallError("No calculator release is published in Ecofy yet.", 409, "NO_RELEASE", "calculator_release");
    const bundle = await ecofyCall<ReleaseBundle>("GET", `/calculator/releases/${pub.id}`);
    const data: EcofyCalculatorRelease = {
        id: bundle.id,
        version: bundle.version,
        appliances: (bundle.appliances ?? [])
            .filter((a) => a.active !== false)
            .map((a) => ({ name: a.name, defaultWatts: a.defaultWatts, isMotor: Boolean(a.isMotor) })),
        segments: bundle.params?.segments ?? {},
    };
    releaseCache = { at: Date.now(), data };
    return data;
}

/** POST /calculator/estimate — a pure read on Ecofy's side, so it stays out of the outbound ledger. */
export function runCalculatorEstimate(input: unknown): Promise<unknown> {
    return ecofyCall("POST", "/calculator/estimate", { body: input, skipLedger: true });
}

// ---------------------------------------------------------------------------
// Calculator designer (Ecofy M08, CONFLICTS #31). The designer screen lives in
// the CRM: the Sales Head drafts, edits, tests, submits and publishes releases
// through Ecofy's own /calculator/releases endpoints. Ecofy keeps the state
// machine, validation and audit; the CRM keeps every write in the ledger.
// ---------------------------------------------------------------------------

export interface EcofyCalcRelease {
    id: string;
    version: number;
    status: "DRAFT" | "PENDING_APPROVAL" | "PUBLISHED" | "RETIRED" | "REJECTED" | string;
    changeNote: string | null;
    decisionNote: string | null;
    createdAt: string;
    submittedAt: string | null;
    publishedAt: string | null;
}

export interface EcofyCalcAppliance {
    name: string;
    defaultWatts: number;
    isMotor: boolean;
    startMultiplier: number;
    sortOrder?: number;
    active?: boolean;
}

export interface EcofyCalcBundle extends EcofyCalcRelease {
    params: Record<string, unknown>;
    appliances: EcofyCalcAppliance[];
    systems: Array<Record<string, unknown>>;
}

export type EcofyCalcDecision = "submit" | "approve" | "reject" | "restore";

/** The published release is cached 5 minutes; any lifecycle change drops it. */
function dropReleaseCache() {
    releaseCache = null;
}

export function listCalcReleases(): Promise<EcofyCalcRelease[]> {
    return ecofyCall<EcofyCalcRelease[]>("GET", "/calculator/releases");
}

export function readCalcRelease(releaseId: string): Promise<EcofyCalcBundle> {
    return ecofyCall<EcofyCalcBundle>("GET", `/calculator/releases/${releaseId}`);
}

export async function createCalcDraft(changeNote: string, actorName: string): Promise<EcofyCalcRelease> {
    const r = await ecofyCall<EcofyCalcRelease>("POST", "/calculator/releases", { body: { changeNote }, actorName });
    dropReleaseCache();
    return r;
}

export async function patchCalcDraft(
    releaseId: string,
    body: { params?: Record<string, unknown>; changeNote?: string },
    actorName: string,
): Promise<EcofyCalcRelease> {
    return ecofyCall<EcofyCalcRelease>("PATCH", `/calculator/releases/${releaseId}`, { body, actorName });
}

export async function putCalcAppliances(releaseId: string, items: EcofyCalcAppliance[], actorName: string): Promise<void> {
    await ecofyCall("PUT", `/calculator/releases/${releaseId}/appliances`, { body: items, actorName });
}

/** FR-08.4 test bench: any input against any release (draft or published). A read on Ecofy's side. */
export function runCalcTestBench(releaseId: string, input: unknown): Promise<unknown> {
    return ecofyCall("POST", `/calculator/releases/${releaseId}/test`, { body: input, skipLedger: true });
}

const DECISION_PATH: Record<EcofyCalcDecision, string> = {
    submit: "submit",
    approve: "approve",
    reject: "reject",
    restore: "restore",
};

/** submit / approve / reject take an optional note (reject requires one); restore takes the new draft's change note. */
export async function decideCalcRelease(
    releaseId: string,
    decision: EcofyCalcDecision,
    note: string | undefined,
    actorName: string,
): Promise<EcofyCalcRelease> {
    const body = decision === "restore" ? { changeNote: note } : { note: note || undefined };
    const r = await ecofyCall<EcofyCalcRelease>("POST", `/calculator/releases/${releaseId}/${DECISION_PATH[decision]}`, {
        body,
        actorName,
    });
    dropReleaseCache();
    return r;
}

export interface EcofyCalcImportResult {
    imported: number;
    rejected: Array<{ rowNo: number; code: string; reason: string }>;
}

/**
 * FR-08.2 standard-systems import. Ecofy's import endpoint wants a committed
 * document id, and documents belong to a case (Ecofy CONFLICTS #22): the
 * template is uploaded as an OTHER document on the first case the integration
 * user can see, then imported into the draft.
 */
export async function importCalcSystems(
    releaseId: string,
    file: { bytes: Buffer; fileName: string; mimeType: string },
    replaceAll: boolean,
    actorName: string,
): Promise<EcofyCalcImportResult> {
    const cases = (await ecofyCall<Array<{ id: string }>>("GET", "/cases", { query: { limit: 1 } })) ?? [];
    const anyCase = cases[0]?.id;
    if (!anyCase) {
        throw new EcofyCallError(
            "The import needs at least one Ecofy case to attach the template file to (Ecofy V1 limitation).",
            409,
            "NO_CASE",
        );
    }
    const doc = await uploadToEcofy({ id: null, ecofy_case_id: anyCase }, { ...file, typeCode: "OTHER" }, actorName);
    return ecofyCall<EcofyCalcImportResult>("POST", `/calculator/releases/${releaseId}/systems/import`, {
        body: { documentId: doc.id, replaceAll },
        actorName,
        ecofyCaseId: anyCase,
    });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface EcofyLeadRef {
    id: string;
    ecofy_case_id: string;
}

/** Runs one validated action against Ecofy. Returns Ecofy's `data`. */
export async function runEcofyAction(lead: EcofyLeadRef, input: EcofyActionInput, actorName: string): Promise<unknown> {
    const c = lead.ecofy_case_id;
    const base = { actorName, ecofyCaseId: c, ecofyLeadId: lead.id };
    switch (input.action) {
        case "log_activity":
            return ecofyCall("POST", `/cases/${c}/activities`, {
                ...base,
                body: {
                    type: input.type,
                    callOutcome: input.type === "CALL" ? input.callOutcome : undefined,
                    note: input.note || undefined,
                    nextFollowUpAt: input.nextFollowUpAt,
                },
            });
        case "book_appointment":
            return ecofyCall("POST", `/cases/${c}/appointments`, {
                ...base,
                body: {
                    meetingType: input.meetingType,
                    scheduledAt: input.scheduledAt,
                    bookingRemarks: input.bookingRemarks || undefined,
                    epcPartnerId: input.meetingType === "EPC_VISIT" ? input.epcPartnerId : undefined,
                },
            });
        case "update_appointment":
            return ecofyCall("PATCH", `/appointments/${input.appointmentId}`, {
                ...base,
                body: {
                    action: input.op,
                    scheduledAt: input.scheduledAt,
                    actualAt: input.actualAt,
                    meetingRemarks: input.meetingRemarks || undefined,
                    outcomeReason: input.outcomeReason || undefined,
                    epcFeedback: input.epcFeedback || undefined,
                },
            });
        case "advance":
            return ecofyCall("POST", `/cases/${c}/advance`, { ...base, ifMatch: input.version });
        case "save_assessment":
            // AssessmentCreate: CALCULATOR carries `calculator`, MANUAL/EPC carry `manual`.
            return ecofyCall("POST", `/cases/${c}/assessments`, { ...base, body: toAssessmentCreate(input) });
        case "confirm_assessment":
            return ecofyCall("POST", `/assessments/${input.assessmentId}/confirm`, { ...base, ifMatch: input.version });
        case "request_eligibility":
            return ecofyCall("POST", `/cases/${c}/eligibility`, { ...base, body: { financierId: input.financierId } });
        case "quote_request":
            return ecofyCall("POST", `/cases/${c}/quote-requests`, {
                ...base,
                body: { epcPartnerId: input.epcPartnerId, channel: input.channel },
            });
        case "update_quote_request":
            return ecofyCall("PATCH", `/quote-requests/${input.quoteRequestId}`, { ...base, body: { status: input.status } });
        case "compose_offer":
            return ecofyCall("POST", `/cases/${c}/offers`, {
                ...base,
                body: { quoteId: input.quoteId },
                idempotencyKey: input.idempotencyKey,
            });
        case "send_otp":
            return ecofyCall("POST", `/offers/${input.offerId}/otp`, {
                ...base,
                ifMatch: input.version,
                idempotencyKey: input.idempotencyKey,
            });
        case "verify_otp":
            return ecofyCall("POST", `/otp/${input.challengeId}/verify`, { ...base, body: { code: input.code } });
        case "create_installation":
            return ecofyCall("POST", `/cases/${c}/installation`, {
                ...base,
                body: { epcPartnerId: input.epcPartnerId, scheduledOn: input.scheduledOn },
            });
        case "update_installation":
            return ecofyCall("PATCH", `/installations/${input.installationId}`, {
                ...base,
                body: {
                    status: input.status,
                    onDate: input.onDate,
                    note: input.note || undefined,
                    stopReason: input.status === "STOPPED" ? input.stopReason : undefined,
                    acknowledgeNoSanction: input.acknowledgeNoSanction || undefined,
                },
            });
        case "request_withdrawal":
            return ecofyCall("POST", `/cases/${c}/withdrawals`, { ...base, body: { reason: input.reason } });
        case "close":
            return ecofyCall("POST", `/cases/${c}/close`, {
                ...base,
                ifMatch: input.version,
                body: { closureReason: input.closureReason, note: input.note || undefined },
            });
        case "return":
            return ecofyCall("POST", `/cases/${c}/return`, {
                ...base,
                ifMatch: input.version,
                body: { reasonCode: input.reasonCode, note: input.note || undefined },
            });
        case "reopen":
            return ecofyCall("POST", `/cases/${c}/reopen`, { ...base, ifMatch: input.version, body: { reason: input.reason } });
        case "route_financier":
            return ecofyCall("POST", `/cases/${c}/route-financier`, {
                ...base,
                ifMatch: input.version,
                body: { financierId: input.financierId, note: input.note },
            });
        case "eligibility_decision":
            return ecofyCall("POST", `/eligibility/${input.eligibilityId}/decision`, {
                ...base,
                body: {
                    status: input.status,
                    maxEligibleInr: input.status === "ELIGIBLE" ? input.maxEligibleInr : undefined,
                    reason: input.status !== "ELIGIBLE" ? input.reason : undefined,
                },
            });
        case "financing_decision":
            return ecofyCall("POST", `/cases/${c}/financing/decisions`, {
                ...base,
                ifMatch: input.version,
                body:
                    input.status === "SANCTIONED"
                        ? {
                              status: "SANCTIONED",
                              values: {
                                  sanctionedInr: input.sanctionedInr,
                                  downPaymentInr: input.downPaymentInr,
                                  tenureMonths: input.tenureMonths,
                                  emiInr: input.emiInr,
                                  lenderFileNo: input.lenderFileNo || undefined,
                              },
                          }
                        : { status: "REJECTED", rejectionReason: input.rejectionReason },
            });
        case "down_payment":
            return ecofyCall("POST", `/cases/${c}/down-payment`, {
                ...base,
                body: { receivedOn: input.receivedOn, amountInr: input.amountInr, reference: input.reference || undefined },
            });
        case "disbursement":
            return ecofyCall("POST", `/cases/${c}/disbursement`, {
                ...base,
                ifMatch: input.version,
                body: { disbursedOn: input.disbursedOn, amountInr: input.amountInr, reference: input.reference || undefined },
            });
        case "withdrawal_confirm":
            return ecofyCall("POST", `/withdrawals/${input.withdrawalId}/confirm`, base);
        case "withdrawal_reject":
            return ecofyCall("POST", `/withdrawals/${input.withdrawalId}/reject`, { ...base, body: { reason: input.reason } });
        case "withdrawal_epc_informed":
            return ecofyCall("POST", `/withdrawals/${input.withdrawalId}/epc-informed`, base);
        case "delete_document":
            return ecofyCall("DELETE", `/documents/${input.documentId}`, { ...base, body: { reason: input.reason } });
    }
}

/** Eligibility decision straight from the queue (the case may not be a CRM lead). */
export function decideEligibility(
    eligibilityId: string,
    body: { status: string; maxEligibleInr?: number; reason?: string },
    actorName: string,
): Promise<unknown> {
    return ecofyCall("POST", `/eligibility/${eligibilityId}/decision`, { body, actorName });
}

export interface EcofyUpload {
    bytes: Buffer;
    fileName: string;
    mimeType: string;
    typeCode: string;
    recordingConsent?: boolean;
}

/**
 * Ecofy's three-step upload, done server-side so the browser never talks to
 * Ecofy: upload-url → PUT bytes to the pre-signed URL → commit with sha256.
 * `quote: true` uses the EPC-quote upload slot.
 */
export async function uploadToEcofy(
    // `id: null` for a case that is not a CRM lead (the calculator designer's template upload).
    lead: { id: string | null; ecofy_case_id: string },
    file: EcofyUpload,
    actorName: string,
    opts: { quote?: boolean } = {},
): Promise<{ id: string }> {
    const c = lead.ecofy_case_id;
    const base = { actorName, ecofyCaseId: c, ecofyLeadId: lead.id };
    const start = await ecofyCall<{ id: string; uploadUrl: string; headers?: Record<string, string> }>(
        "POST",
        `/cases/${c}/${opts.quote ? "quotes" : "documents"}/upload-url`,
        {
            ...base,
            body: { typeCode: file.typeCode, fileName: file.fileName, mimeType: file.mimeType, sizeBytes: file.bytes.length },
        },
    );
    const put = await fetch(start.uploadUrl, {
        method: "PUT",
        body: new Uint8Array(file.bytes),
        headers: start.headers ?? { "Content-Type": file.mimeType },
        signal: AbortSignal.timeout(60_000),
    });
    if (!put.ok) throw new EcofyCallError(`Upload to Ecofy storage failed (${put.status})`, 502);
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    return ecofyCall<{ id: string }>("POST", `/cases/${c}/documents`, {
        ...base,
        body: {
            documentId: start.id,
            sha256,
            ...(file.recordingConsent !== undefined ? { recordingConsent: file.recordingConsent } : {}),
        },
    });
}

export interface EcofyQuoteFields {
    assessmentId: string;
    epcPartnerId: string;
    systemDesc: string;
    batteryKwh?: number;
    inverterKva?: number;
    solarKwp?: number;
    equipmentInr: number;
    installationInr: number;
    gstInr: number;
    validUntil: string;
    notes?: string;
    provisional?: boolean;
    provisionalReason?: string;
}

/** EPC quote = PDF upload + quote record, one Idempotency-Key for the record. */
export async function uploadQuote(
    lead: EcofyLeadRef,
    pdf: EcofyUpload,
    fields: EcofyQuoteFields,
    actorName: string,
    idempotencyKey: string,
): Promise<unknown> {
    const doc = await uploadToEcofy(lead, { ...pdf, typeCode: "EPC_QUOTE" }, actorName, { quote: true });
    return ecofyCall("POST", `/cases/${lead.ecofy_case_id}/quotes`, {
        actorName,
        ecofyCaseId: lead.ecofy_case_id,
        ecofyLeadId: lead.id,
        idempotencyKey,
        body: { documentId: doc.id, ...fields },
    });
}

// ---------------------------------------------------------------------------
// Lead intake (M03, gap 11): single lead + bulk import. Managers only — the
// routes gate that; Ecofy takes POST /cases from ECOFY_USER / ECOFY_ADMIN /
// ITARANG_ADMIN and /imports* from ECOFY_ADMIN / ITARANG_ADMIN.
// ---------------------------------------------------------------------------

/**
 * POST /cases as iTarang Admin → the case starts at S1, owned by iTarang
 * (OpenAPI CaseCreate; BRD FR-03.8). The returned Case is upserted into
 * ecofy_leads with the same version-guarded upsert the inbound push uses, so
 * the lead is in the pickup queue at once. Returns the case and the CRM lead id.
 */
export async function createEcofyCase(
    input: CaseCreateInput,
    idempotencyKey: string,
    actorName: string,
): Promise<{ case: Record<string, unknown>; leadId: string | null }> {
    const created = await ecofyCall<Record<string, unknown>>("POST", "/cases", { body: input, idempotencyKey, actorName });
    if (!created || typeof created.id !== "string") {
        throw new EcofyCallError("Ecofy created the lead but returned no case id.", 502);
    }
    let leadId: string | null = null;
    try {
        leadId = await upsertEcofyLeadSnapshot(caseToLeadSnapshot(created, input), "crm.case_created");
    } catch (err) {
        // The case exists in Ecofy; its push brings it into the CRM later.
        console.error("[Ecofy] local upsert after create failed:", errorMessage(err));
    }
    return { case: created, leadId };
}

/**
 * Start an import and upload the file: POST /imports {fileName, sizeBytes} →
 * UploadTicket → PUT the bytes to its presigned URL, server-side like
 * uploadToEcofy, so the browser never talks to Ecofy or its storage.
 */
export async function startEcofyImport(
    file: { bytes: Buffer; fileName: string; mimeType: string },
    actorName: string,
): Promise<EcofyUploadTicket> {
    const ticket = await ecofyCall<EcofyUploadTicket>("POST", "/imports", {
        body: { fileName: file.fileName, sizeBytes: file.bytes.length },
        actorName,
    });
    const put = await fetch(ticket.uploadUrl, {
        method: "PUT",
        body: new Uint8Array(file.bytes),
        headers: { "Content-Type": file.mimeType },
        signal: AbortSignal.timeout(60_000),
    });
    if (!put.ok) throw new EcofyCallError(`Upload to Ecofy storage failed (${put.status})`, 502);
    return ticket;
}

export function saveEcofyImportMapping(
    importId: string,
    body: { mapping: Record<string, string>; saveAs?: string },
    actorName: string,
): Promise<EcofyImport> {
    return ecofyCall<EcofyImport>("POST", `/imports/${encodeURIComponent(importId)}/mapping`, { body, actorName });
}

/** Dry run: counts and sample row errors; nothing is created (BRD FR-03.4). */
export function validateEcofyImport(importId: string, actorName: string): Promise<EcofyImportPreview> {
    return ecofyCall<EcofyImportPreview>("POST", `/imports/${encodeURIComponent(importId)}/validate`, { actorName });
}

/** Commit with the consent attestation; Ecofy runs it as a background job (202, BRD FR-03.5). */
export function commitEcofyImport(
    importId: string,
    attestationText: string,
    idempotencyKey: string,
    actorName: string,
): Promise<EcofyImport> {
    return ecofyCall<EcofyImport>("POST", `/imports/${encodeURIComponent(importId)}/commit`, {
        body: { consentAttested: true, attestationText },
        idempotencyKey,
        actorName,
    });
}

export function readEcofyImport(importId: string): Promise<EcofyImport> {
    return ecofyCall<EcofyImport>("GET", `/imports/${encodeURIComponent(importId)}`);
}

/**
 * The upload template or an import's row report, as Ecofy sends it (no JSON
 * envelope; OpenAPI declares only `200 OK`). Throws EcofyCallError on a
 * non-2xx, like every other call.
 */
export async function fetchEcofyImportFile(
    what: { kind: "template" } | { kind: "report"; importId: string },
): Promise<Response> {
    const path =
        what.kind === "template" ? "/imports/template" : `/imports/${encodeURIComponent(what.importId)}/report.csv`;
    let res: Response;
    try {
        res = await callEcofyApiRaw({ method: "GET", path, timeoutMs: 30_000 });
    } catch (err) {
        throw new EcofyCallError(`Could not reach Ecofy: ${errorMessage(err)}`, 502);
    }
    if (!res.ok) {
        let msg = `Ecofy answered ${res.status}`;
        try {
            const j = (await res.json()) as { error?: { message?: string; code?: string } };
            msg = friendly(res.status, j.error?.code, undefined, j.error?.message);
        } catch {
            /* non-JSON error body */
        }
        throw new EcofyCallError(msg, res.status);
    }
    return res;
}

// ---------------------------------------------------------------------------
// Local snapshot
// ---------------------------------------------------------------------------

interface EcofyCaseView {
    version: number;
    stage: string | null;
    subStatus: string | null;
    temperature: string | null;
    closureReason: string | null;
    queueEnteredAt: string | null;
}

/**
 * Pull the case back from Ecofy after a CRM write so lists, badges and
 * notifications see the new stage at once instead of waiting for Ecofy's
 * `lead.stage_changed` push. Version-guarded like the inbound upsert, so it
 * can never roll a newer push back. Returns the previous and current stage.
 */
export async function refreshLeadFromEcofy(
    lead: EcofyLeadRef,
): Promise<{ fromStage: string | null; toStage: string | null; version: number | null }> {
    const [before] = await db
        .select({ stage: ecofyLeads.stage })
        .from(ecofyLeads)
        .where(eq(ecofyLeads.id, lead.id))
        .limit(1);
    try {
        const k = await ecofyCall<EcofyCaseView>("GET", `/cases/${lead.ecofy_case_id}`);
        await db.execute(sql`
            UPDATE ecofy_leads SET
                version = ${k.version},
                stage = ${k.stage},
                sub_status = ${k.subStatus},
                temperature = ${k.temperature ? k.temperature.toUpperCase() : null},
                closure_reason = ${k.closureReason},
                snapshot = snapshot || ${JSON.stringify({ stage: k.stage, subStatus: k.subStatus, version: k.version })}::jsonb,
                updated_at = now()
            WHERE id = ${lead.id}::uuid AND version <= ${k.version}
        `);
        return { fromStage: before?.stage ?? null, toStage: k.stage, version: k.version };
    } catch (err) {
        console.warn("[Ecofy] refresh after write failed:", errorMessage(err));
        return { fromStage: before?.stage ?? null, toStage: before?.stage ?? null, version: null };
    }
}
