import { describe, expect, it, vi } from "vitest";
import * as XLSX from "xlsx";
import {
    caseCreateSchema,
    caseToLeadSnapshot,
    checkImportFile,
    crmCaseCreateSchema,
    defaultImportMapping,
    importCommitSchema,
    importMappingSchema,
    LEAD_TEMPLATE_COLUMNS,
    unmappedRequiredColumns,
} from "../intake";
import { ecofyLeadSchema } from "../inbound";
import { readImportHeaders } from "../importHeaders";

// inbound.ts imports the DB client at module load; only its zod schema is used here.
vi.mock("@/lib/db", () => ({ db: {} }));

const customer = {
    fullName: "Rohit Sharma",
    mobile: "9876543210",
    customerType: "INDIVIDUAL",
    address: "H.No 12, Sector 45",
    city: "Gurugram",
    state: "Haryana",
    pincode: "122001",
    consentObtained: true,
    consentDate: "2026-09-15",
    consentSource: "WEBSITE_FORM",
};
const valid = { customer, segment: "RESI" };

describe("CaseCreate (OpenAPI CustomerIn / CaseCreate)", () => {
    it("accepts the template's example lead", () => {
        expect(caseCreateSchema.safeParse(valid).success).toBe(true);
    });

    it("enforces the mobile and pincode patterns", () => {
        for (const mobile of ["5876543210", "987654321", "+919876543210", "98765 43210"]) {
            expect(caseCreateSchema.safeParse({ ...valid, customer: { ...customer, mobile } }).success).toBe(false);
        }
        expect(caseCreateSchema.safeParse({ ...valid, customer: { ...customer, pincode: "022001" } }).success).toBe(false);
        expect(caseCreateSchema.safeParse({ ...valid, customer: { ...customer, altMobile: "123" } }).success).toBe(false);
    });

    it("requires consent (const true), a consent date not in the future and a source", () => {
        expect(caseCreateSchema.safeParse({ ...valid, customer: { ...customer, consentObtained: false } }).success).toBe(false);
        expect(caseCreateSchema.safeParse({ ...valid, customer: { ...customer, consentDate: "2999-01-01" } }).success).toBe(false);
        expect(caseCreateSchema.safeParse({ ...valid, customer: { ...customer, consentDate: "15-09-2026" } }).success).toBe(false);
        const noSource = { ...customer } as Partial<typeof customer>;
        delete noSource.consentSource;
        expect(caseCreateSchema.safeParse({ ...valid, customer: noSource }).success).toBe(false);
    });

    it("needs a business name for a business customer", () => {
        const biz = { ...customer, customerType: "BUSINESS" };
        expect(caseCreateSchema.safeParse({ ...valid, customer: biz }).success).toBe(false);
        expect(caseCreateSchema.safeParse({ ...valid, customer: { ...biz, businessName: "Meena Traders" } }).success).toBe(true);
    });

    it("only takes RESI / ESS / CI and whole-rupee bills; blanks are omitted", () => {
        expect(caseCreateSchema.safeParse({ ...valid, segment: "C&I" }).success).toBe(false);
        expect(caseCreateSchema.safeParse({ ...valid, avgMonthlyBillInr: 4500.5 }).success).toBe(false);
        const r = caseCreateSchema.parse({ ...valid, avgMonthlyBillInr: "4500", sanctionedLoadKw: "", productInterest: "", customer: { ...customer, email: "" } });
        expect(r.avgMonthlyBillInr).toBe(4500);
        expect(r.sanctionedLoadKw).toBeUndefined();
        expect(r.productInterest).toBeUndefined();
        expect(r.customer.email).toBeUndefined();
    });

    it("the CRM route requires an Idempotency-Key of 8–100 chars", () => {
        expect(crmCaseCreateSchema.safeParse(valid).success).toBe(false);
        expect(crmCaseCreateSchema.safeParse({ ...valid, idempotencyKey: "short" }).success).toBe(false);
        expect(crmCaseCreateSchema.safeParse({ ...valid, idempotencyKey: "4f1c2b8e-0000-4000-8000-000000000000" }).success).toBe(true);
    });
});

describe("caseToLeadSnapshot", () => {
    const sent = caseCreateSchema.parse({ ...valid, productInterest: "SOLAR_STORAGE", avgMonthlyBillInr: 4500 });

    it("maps an Ecofy Case into the inbound lead snapshot, falling back to what was sent", () => {
        const snap = caseToLeadSnapshot(
            {
                id: "c-1",
                caseNo: "ECO-0001",
                version: 1,
                stage: "S1",
                segment: "RESI",
                source: "ITARANG",
                owner: "ITARANG",
                stageEnteredAt: "2026-10-01T05:00:00Z",
                customer: { fullName: "Rohit Sharma", mobile: "+919876543210" },
            },
            sent,
        );
        expect(snap.ecofyCaseId).toBe("c-1");
        expect(snap.stage).toBe("S1");
        expect(snap.owner).toBe("ITARANG");
        expect(snap.queueEnteredAt).toBe("2026-10-01T05:00:00Z");
        expect(snap.productInterest).toBe("SOLAR_STORAGE");
        expect(snap.avgMonthlyBillInr).toBe(4500);
        expect((snap.customer as Record<string, unknown>).mobile).toBe("+919876543210");
        expect((snap.customer as Record<string, unknown>).city).toBe("Gurugram");
        // Must satisfy the schema the shared upsert parses with.
        expect(ecofyLeadSchema.safeParse(snap).success).toBe(true);
    });

    it("does not invent a queue time outside S1", () => {
        const snap = caseToLeadSnapshot({ id: "c-2", version: 0, stage: "S0", stageEnteredAt: "2026-10-01T05:00:00Z" }, sent);
        expect(snap.queueEnteredAt).toBeNull();
        expect(snap.segment).toBe("RESI");
    });
});

describe("bulk import helpers", () => {
    it("checks the file per ImportStart (.xlsx/.csv, 1 B … 10 MB)", () => {
        expect(checkImportFile("leads.xlsx", 1000)).toBeNull();
        expect(checkImportFile("LEADS.CSV", 1000)).toBeNull();
        expect(checkImportFile("leads.xls", 1000)).toMatch(/xlsx or \.csv/);
        expect(checkImportFile("leads.xlsx", 0)).toMatch(/empty/);
        expect(checkImportFile("leads.xlsx", 10_485_761)).toMatch(/10 MB/);
    });

    it("auto-maps headers that equal template columns (case/space/dash-insensitive), once each", () => {
        const m = defaultImportMapping(["Customer Name", "mobile", "Pin code", "segment", "MOBILE", "consent-date"]);
        expect(m).toEqual({ "Customer Name": "customer_name", mobile: "mobile", segment: "segment", "consent-date": "consent_date" });
    });

    it("reports mandatory columns left unmapped", () => {
        const all = Object.fromEntries(LEAD_TEMPLATE_COLUMNS.map((c) => [c, c]));
        expect(unmappedRequiredColumns(all)).toEqual([]);
        expect(unmappedRequiredColumns({ x: "mobile" })).toContain("consent_obtained");
    });

    it("ImportMapping: template columns only, each mapped once, at least one", () => {
        expect(importMappingSchema.safeParse({ mapping: { Name: "customer_name" } }).success).toBe(true);
        expect(importMappingSchema.safeParse({ mapping: { Name: "full_name" } }).success).toBe(false);
        expect(importMappingSchema.safeParse({ mapping: { A: "mobile", B: "mobile" } }).success).toBe(false);
        expect(importMappingSchema.safeParse({ mapping: {} }).success).toBe(false);
        expect(importMappingSchema.safeParse({ mapping: { A: "mobile" }, saveAs: "x".repeat(61) }).success).toBe(false);
    });

    it("ImportCommit: consentAttested must be true, with the text and an Idempotency-Key", () => {
        const ok = { consentAttested: true, attestationText: "Consent is held for every lead.", idempotencyKey: "abcdefgh-1" };
        expect(importCommitSchema.safeParse(ok).success).toBe(true);
        expect(importCommitSchema.safeParse({ ...ok, consentAttested: false }).success).toBe(false);
        expect(importCommitSchema.safeParse({ ...ok, attestationText: "" }).success).toBe(false);
        expect(importCommitSchema.safeParse({ ...ok, idempotencyKey: "abc" }).success).toBe(false);
    });

    it("reads the header row from the template's Leads sheet, or a CSV's first row", () => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["How to fill"]]), "How to fill");
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["customer_name", "mobile", "", "mobile"], ["A", "9876543210"]]), "Leads");
        const xlsx = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
        expect(readImportHeaders(xlsx)).toEqual(["customer_name", "mobile"]);
        expect(readImportHeaders(Buffer.from("Name,Phone\nA,9876543210\n"))).toEqual(["Name", "Phone"]);
    });
});
