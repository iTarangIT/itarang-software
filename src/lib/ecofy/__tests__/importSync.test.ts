import { describe, expect, it, vi } from "vitest";
import { caseNosToSync, isMirroredStage, parseImportReport, pickCaseByNo, tallyImportSync } from "../importSync";
import { caseToLeadSnapshot } from "../intake";
// inbound.ts imports the db client; only its zod schema is used here.
vi.mock("@/lib/db", () => ({ db: {} }));
import { ecofyLeadSchema } from "../inbound";

// The shape Ecofy's importReportCsv() writes (m03-intake/service.ts):
// row_no, result, case_no, reasons, customer_name, mobile.
const REPORT = [
    "﻿row_no,result,case_no,reasons,customer_name,mobile",
    "1,CREATED,ECF-120,,Asha Rao,9876543210",
    '2,DUPLICATE,ECF-007,"DUPLICATE_OPEN_CASE: linked to open case ECF-007",Ravi,9876500000',
    '3,REJECTED,,"mobile: must be a 10-digit Indian mobile",Bad Row,12345',
    "4,REOPENED,ECF-055,,Meena,9811111111",
    '5,CREATED,ECF-121,"NEW_LINKED: linked to closed case with a File; new case ECF-121",Old,9822222222',
    "6,DUPLICATE,ecf-120,,Asha Rao again,9876543210",
    "",
].join("\r\n");

describe("ID 51 #3 — import report → cases to bring into the CRM", () => {
    it("parses the report (BOM, CRLF, quoted commas, empty case_no)", () => {
        const rows = parseImportReport(REPORT);
        expect(rows).toHaveLength(6);
        expect(rows[0]).toEqual({ rowNo: 1, result: "CREATED", caseNo: "ECF-120" });
        expect(rows[1]).toEqual({ rowNo: 2, result: "DUPLICATE", caseNo: "ECF-007" });
        expect(rows[2]).toEqual({ rowNo: 3, result: "REJECTED", caseNo: null });
    });

    it("keeps created / reopened / duplicate-linked cases once each, in row order; never a rejected row", () => {
        expect(caseNosToSync(parseImportReport(REPORT))).toEqual(["ECF-120", "ECF-007", "ECF-055", "ECF-121"]);
    });

    it("accepts columns in any order and ignores unknown results", () => {
        const csv = "case_no,result,row_no\nECF-9,CREATED,1\nECF-10,SOMETHING_NEW,2\n,CREATED,3\n";
        expect(caseNosToSync(parseImportReport(csv))).toEqual(["ECF-9"]);
    });

    it("an empty report syncs nothing", () => {
        expect(caseNosToSync(parseImportReport("row_no,result,case_no\n"))).toEqual([]);
    });
});

describe("ID 51 #3 — case search match and stage rule", () => {
    const list = [
        { id: "c-1200", caseNo: "ECF-1200", stage: "S1" },
        { id: "c-120", caseNo: "ECF-120", stage: "S1" },
        { id: "c-12", caseNo: "ECF-12", stage: "S0" },
    ];

    it("takes only the exact case number from a substring search", () => {
        expect(pickCaseByNo(list, "ECF-120")?.id).toBe("c-120");
        expect(pickCaseByNo(list, " ecf-12 ")?.id).toBe("c-12");
        expect(pickCaseByNo(list, "ECF-1")).toBeNull();
        expect(pickCaseByNo(null, "ECF-120")).toBeNull();
    });

    it("refuses an ambiguous match instead of guessing", () => {
        expect(pickCaseByNo([...list, { id: "other", caseNo: "ECF-120" }], "ECF-120")).toBeNull();
    });

    it("mirrors every stage except Ecofy's own S0 qualification", () => {
        expect(isMirroredStage("S1")).toBe(true);
        expect(isMirroredStage("S6")).toBe(true);
        expect(isMirroredStage("CLOSED")).toBe(true);
        expect(isMirroredStage("S0")).toBe(false);
        expect(isMirroredStage(null)).toBe(false);
        expect(isMirroredStage("")).toBe(false);
    });

    it("tallies the outcomes", () => {
        const r = tallyImportSync({ importId: "i", status: "COMMITTED", reportRows: 6, cases: 4 }, [
            "added",
            "added",
            "updated",
            "skipped_s0",
        ]);
        expect(r).toMatchObject({ checked: 4, added: 2, updated: 1, skippedS0: 1, notFound: 0, failed: 0 });
    });
});

describe("ID 51 #3 — a fetched Case becomes the same snapshot a push stores", () => {
    it("works without the create payload and passes the inbound schema (upsert key = ecofyCaseId)", () => {
        const kase = {
            id: "0aac7edb-0000-4000-8000-000000000001",
            caseNo: "ECF-120",
            version: 1,
            stage: "S1",
            subStatus: null,
            segment: "RESI",
            temperature: null,
            source: "ITARANG_SOURCED",
            owner: "ITARANG",
            stageEnteredAt: "2026-10-12T05:00:00.000Z",
            customer: { fullName: "Asha Rao", mobile: "9876543210", city: "Pune", state: "MH", pincode: "411001" },
        };
        const snap = caseToLeadSnapshot(kase);
        expect(snap.ecofyCaseId).toBe(kase.id);
        expect(snap.queueEnteredAt).toBe(kase.stageEnteredAt); // S1 → in the pickup queue at once
        const parsed = ecofyLeadSchema.parse(snap);
        expect(parsed.ecofyCaseId).toBe(kase.id);
        expect(parsed.customer?.address ?? null).toBeNull();
    });
});
