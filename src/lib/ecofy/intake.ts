// Ecofy lead intake from the CRM (M03, tracker ID 51 gap 11).
//
// Two paths, both iTarang Admin calls in Ecofy (the CRM's integration user):
//   - single lead: POST /cases (CaseCreate) with an Idempotency-Key. An
//     ITARANG_ADMIN create lands at S1, owned by iTarang (OpenAPI CaseCreate
//     description; BRD FR-03.8).
//   - bulk import: /imports → PUT to the presigned URL → /mapping →
//     /validate → /commit (consent attestation, Idempotency-Key) → poll →
//     /report.csv (OpenAPI M03 Intake; BRD FR-03.1 … FR-03.5, FR-03.9).
//
// Field rules mirror docs/ecofy-handoff/.../ecofy_openapi_v1.0.1.yaml
// (CustomerIn, CaseCreate, ImportStart, ImportMapping, ImportCommit) and the
// lead upload template v0.3. Ecofy validates everything again.
//
// Pure: no DB, no env. Imported by API routes, client components and tests.

import { z } from "zod";

/** Lead upload template v0.3, sheet "Leads", in column order. */
export const LEAD_TEMPLATE_COLUMNS = [
    "customer_name",
    "mobile",
    "segment",
    "pincode",
    "consent_obtained",
    "consent_date",
    "consent_source",
    "city",
    "state",
    "address",
    "customer_type",
    "business_name",
    "ecofy_lead_id",
    "alternate_mobile",
    "email",
    "preferred_language",
    "property_type",
    "product_interest",
    "avg_monthly_bill_inr",
    "sanctioned_load_kw",
    "existing_backup",
    "preferred_call_time",
    "assign_to",
] as const;
export type LeadTemplateColumn = (typeof LEAD_TEMPLATE_COLUMNS)[number];

/** Template v0.3 "Field guide": Required = Yes (business_name is conditional). */
export const LEAD_TEMPLATE_REQUIRED: readonly LeadTemplateColumn[] = [
    "customer_name",
    "mobile",
    "segment",
    "pincode",
    "consent_obtained",
    "consent_date",
    "consent_source",
    "city",
    "state",
    "address",
    "customer_type",
];

/** ImportStart: fileName pattern \.(xlsx|csv)$, sizeBytes 1 … 10485760. */
export const IMPORT_MAX_BYTES = 10_485_760;
export const IMPORT_FILE_RE = /\.(xlsx|csv)$/i;

export const ECOFY_SEGMENTS = ["RESI", "ESS", "CI"] as const;
export const ECOFY_CUSTOMER_TYPES = ["INDIVIDUAL", "BUSINESS"] as const;

const MOBILE_RE = /^[6-9][0-9]{9}$/;
const PINCODE_RE = /^[1-9][0-9]{5}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "" and whitespace-only → undefined, so an empty form field is simply omitted. */
function blankToUndefined(v: unknown): unknown {
    return typeof v === "string" && v.trim() === "" ? undefined : v;
}
const optText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optNumber = z.preprocess(
    (v) => (v === "" || v === null ? undefined : typeof v === "string" ? Number(v) : v),
    z.number().nonnegative().optional(),
);

/** Today in IST as YYYY-MM-DD (the platform's calendar zone). */
export function todayIstIso(now: Date = new Date()): string {
    return now.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

/** CustomerIn. consentObtained is `const: true` in the contract. */
export const customerInSchema = z
    .object({
        fullName: z.string().trim().min(2).max(100),
        mobile: z.string().trim().regex(MOBILE_RE, "10-digit Indian mobile starting 6–9, no +91"),
        altMobile: z.preprocess(
            blankToUndefined,
            z.string().trim().regex(MOBILE_RE, "10-digit Indian mobile starting 6–9, no +91").optional(),
        ),
        email: z.preprocess(blankToUndefined, z.string().trim().toLowerCase().email().optional()),
        customerType: z.enum(ECOFY_CUSTOMER_TYPES),
        businessName: optText(200),
        address: z.string().trim().min(3).max(250),
        city: z.string().trim().min(1).max(100),
        state: z.string().trim().min(1).max(100),
        pincode: z.string().trim().regex(PINCODE_RE, "6 digits, not starting with 0"),
        preferredLanguage: optText(60),
        propertyType: optText(60),
        consentObtained: z.literal(true, { message: "Consent must be obtained before a lead is created" }),
        consentDate: z
            .string()
            .regex(DATE_RE, "YYYY-MM-DD")
            // BRD §7.3 consent_date: "not in the future".
            .refine((d) => d <= todayIstIso(), { message: "Consent date cannot be in the future" }),
        consentSource: z.string().trim().min(1).max(60),
    })
    // Template v0.3 field guide / BRD §7.3: business_name required when Business.
    .refine((c) => c.customerType !== "BUSINESS" || Boolean(c.businessName), {
        message: "Business name is required for a business customer",
        path: ["businessName"],
    });

/** CaseCreate (without fromEstimateId — see docs/tasks/ecofy-gap-audit.md, conflicts). */
export const caseCreateSchema = z.object({
    customer: customerInSchema,
    segment: z.enum(ECOFY_SEGMENTS),
    productInterest: optText(60),
    avgMonthlyBillInr: z.preprocess(
        (v) => (v === "" || v === null ? undefined : typeof v === "string" ? Number(v) : v),
        z.number().int("Whole rupees").nonnegative().optional(),
    ),
    sanctionedLoadKw: optNumber,
    existingBackup: optText(60),
    preferredCallTime: optText(60),
});
export type CaseCreateInput = z.infer<typeof caseCreateSchema>;

/** Body of POST /api/ecofy/cases: the CaseCreate plus the client's Idempotency-Key. */
export const crmCaseCreateSchema = caseCreateSchema.extend({
    // Required header on POST /cases; minLength 8, maxLength 100. The browser
    // generates one per form so a double-submit or retry cannot create twice.
    idempotencyKey: z.string().min(8).max(100),
});

/** ImportMapping: source header → template column; one source per column. */
export const importMappingSchema = z
    .object({
        mapping: z.record(z.string().min(1).max(200), z.enum(LEAD_TEMPLATE_COLUMNS)),
        saveAs: optText(60),
    })
    .refine((m) => new Set(Object.values(m.mapping)).size === Object.values(m.mapping).length, {
        message: "Each template column can be mapped from one source column only",
        path: ["mapping"],
    })
    .refine((m) => Object.keys(m.mapping).length > 0, { message: "Map at least one column", path: ["mapping"] });

/** ImportCommit (consentAttested is `const: true`) plus the required Idempotency-Key. */
export const importCommitSchema = z.object({
    consentAttested: z.literal(true, { message: "Confirm that consent is held for every lead in the file" }),
    attestationText: z.string().trim().min(10).max(1000),
    idempotencyKey: z.string().min(8).max(100),
});

/** The attestation shown next to the tick and sent verbatim (BRD FR-03.5: "text and time logged"). */
export const DEFAULT_ATTESTATION_TEXT =
    "I confirm that consent to be contacted is held for every lead in this file, as recorded in the consent columns.";

export function checkImportFile(name: string, size: number): string | null {
    if (!IMPORT_FILE_RE.test(name)) return "Upload the lead file as .xlsx or .csv";
    if (size < 1) return "The file is empty";
    if (size > IMPORT_MAX_BYTES) return "Max 10 MB";
    return null;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Default mapping for the wizard: a source header that equals a template
 * column (case, spaces and dashes ignored) maps to it. Everything else is left
 * for the user to map (BRD FR-03.3 "headers auto-matched; the rest mapped").
 */
export function defaultImportMapping(headers: string[]): Record<string, LeadTemplateColumn> {
    const out: Record<string, LeadTemplateColumn> = {};
    const used = new Set<string>();
    for (const h of headers) {
        const col = LEAD_TEMPLATE_COLUMNS.find((c) => c === norm(h));
        if (col && !used.has(col)) {
            out[h] = col;
            used.add(col);
        }
    }
    return out;
}

/** Mandatory template columns no source header is mapped to. */
export function unmappedRequiredColumns(mapping: Record<string, string>): LeadTemplateColumn[] {
    const mapped = new Set(Object.values(mapping));
    return LEAD_TEMPLATE_REQUIRED.filter((c) => !mapped.has(c));
}

// ---------------------------------------------------------------------------
// Case (POST /cases response) → the snapshot ecofy_leads stores
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Shape a Case returned by Ecofy into the lead snapshot the inbound upsert
 * (src/lib/ecofy/inbound.ts, ecofyLeadSchema) stores, so a CRM-created lead
 * shows in the queue at once instead of waiting for Ecofy's push. Case is
 * `additionalProperties: true`; anything it leaves out falls back to what the
 * CRM sent. queueEnteredAt falls back to stageEnteredAt only at S1 (the stage
 * the pickup queue lists).
 */
export function caseToLeadSnapshot(kase: Rec, sent: CaseCreateInput): Rec & { ecofyCaseId: string; version: number } {
    const c = (kase.customer && typeof kase.customer === "object" ? kase.customer : {}) as Rec;
    const stage = str(kase.stage);
    return {
        ecofyCaseId: String(kase.id),
        caseNo: str(kase.caseNo),
        version: num(kase.version) ?? 0,
        stage,
        subStatus: str(kase.subStatus),
        segment: str(kase.segment) ?? sent.segment,
        temperature: str(kase.temperature),
        source: str(kase.source),
        owner: str(kase.owner),
        qualifiedByName: str(kase.qualifiedByName),
        queueEnteredAt: str(kase.queueEnteredAt) ?? (stage === "S1" ? str(kase.stageEnteredAt) : null),
        productInterest: str(kase.productInterest) ?? sent.productInterest ?? null,
        avgMonthlyBillInr: num(kase.avgMonthlyBillInr) ?? sent.avgMonthlyBillInr ?? null,
        sanctionedLoadKw: num(kase.sanctionedLoadKw) ?? sent.sanctionedLoadKw ?? null,
        existingBackup: str(kase.existingBackup) ?? sent.existingBackup ?? null,
        preferredCallTime: str(kase.preferredCallTime) ?? sent.preferredCallTime ?? null,
        closureReason: str(kase.closureReason),
        ecofyUrl: str(kase.ecofyUrl),
        customer: {
            fullName: str(c.fullName) ?? sent.customer.fullName,
            mobile: str(c.mobile) ?? sent.customer.mobile,
            altMobile: str(c.altMobile) ?? sent.customer.altMobile ?? null,
            email: str(c.email) ?? sent.customer.email ?? null,
            customerType: str(c.customerType) ?? sent.customer.customerType,
            businessName: str(c.businessName) ?? sent.customer.businessName ?? null,
            address: str(c.address) ?? sent.customer.address,
            city: str(c.city) ?? sent.customer.city,
            state: str(c.state) ?? sent.customer.state,
            pincode: str(c.pincode) ?? sent.customer.pincode,
            preferredLanguage: str(c.preferredLanguage) ?? sent.customer.preferredLanguage ?? null,
            propertyType: str(c.propertyType) ?? sent.customer.propertyType ?? null,
        },
    };
}

// ---------------------------------------------------------------------------
// Shapes Ecofy returns for imports (OpenAPI Import / ImportPreview / UploadTicket)
// ---------------------------------------------------------------------------

export interface EcofyImportPreview {
    rowCount: number;
    created: number;
    duplicate: number;
    reopened: number;
    newLinked: number;
    rejected: number;
    sampleErrors?: Array<{ rowNo: number; column?: string; code: string; message?: string }>;
}

export type EcofyImportStatus = "UPLOADED" | "MAPPED" | "VALIDATED" | "COMMITTING" | "COMMITTED" | "FAILED";

export interface EcofyImport {
    id: string;
    status: EcofyImportStatus;
    preview?: EcofyImportPreview;
}

export interface EcofyUploadTicket {
    id: string;
    uploadUrl: string;
    expiresAt: string;
}

export const IMPORT_TERMINAL: readonly EcofyImportStatus[] = ["COMMITTED", "FAILED"];
