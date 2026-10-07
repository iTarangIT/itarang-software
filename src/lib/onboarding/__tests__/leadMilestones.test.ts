import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const dialect = new PgDialect();
const statements: { sql: string; params: unknown[] }[] = [];
let fail = false;
const execute = vi.fn(async (q: SQL) => {
    if (fail) throw new Error('column "agreement_outcome" does not exist');
    const r = dialect.sqlToQuery(q);
    statements.push({ sql: r.sql, params: r.params });
    return [];
});
vi.mock("@/lib/db", () => ({ db: { execute } }));

const { markDocsSubmitted, markAgreementOutcome, agreementOutcomeLabel } = await import("../leadMilestones");
const APP = "a3d6f866-6339-4e6f-9875-0aac33786cb1";

beforeEach(() => {
    statements.length = 0;
    fail = false;
    execute.mockClear();
});

describe("leadMilestones", () => {
    it("docs submitted: first write wins, resolved via the application", async () => {
        await markDocsSubmitted(APP);
        expect(statements[0].sql).toMatch(/COALESCE\(dl\.onboarding_docs_submitted_at, NOW\(\)\)/);
        expect(statements[0].sql).toMatch(/originating_dealer_lead_id/);
        expect(statements[0].params).toContain(APP);
    });
    it("skips a missing / non-uuid application id", async () => {
        await markDocsSubmitted(null);
        await markDocsSubmitted("not-a-uuid");
        await markAgreementOutcome({ applicationId: "x" }, "failed");
        expect(execute).not.toHaveBeenCalled();
    });
    it("agreement outcome by application or by lead", async () => {
        await markAgreementOutcome({ applicationId: APP }, "signed");
        await markAgreementOutcome({ dealerLeadId: "DL-1" }, "expired");
        expect(statements[0].params).toEqual(expect.arrayContaining(["signed", APP]));
        expect(statements[1].sql).toMatch(/WHERE dl\.id = \$2/);
        expect(statements[1].params).toEqual(expect.arrayContaining(["expired", "DL-1"]));
    });
    it("writes the manual and not-needed outcomes (ID 84.1)", async () => {
        await markAgreementOutcome({ applicationId: APP }, "manual_on_file");
        await markAgreementOutcome({ applicationId: APP }, "not_needed");
        expect(statements[0].params).toEqual(expect.arrayContaining(["manual_on_file", APP]));
        expect(statements[1].params).toEqual(expect.arrayContaining(["not_needed", APP]));
    });
    it("labels every outcome, reading a pre-84.1 'completed' row as Signed", () => {
        expect(agreementOutcomeLabel("signed")).toBe("Signed");
        expect(agreementOutcomeLabel("manual_on_file")).toBe("Manual agreement on file");
        expect(agreementOutcomeLabel("not_needed")).toBe("Not needed");
        expect(agreementOutcomeLabel("failed")).toBe("Failed");
        expect(agreementOutcomeLabel("cancelled")).toBe("Cancelled");
        expect(agreementOutcomeLabel("expired")).toBe("Expired");
        expect(agreementOutcomeLabel("completed")).toBe("Signed");
        expect(agreementOutcomeLabel(null)).toBeNull();
        expect(agreementOutcomeLabel("bogus")).toBeNull();
    });
    it("never throws", async () => {
        fail = true;
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        await expect(markDocsSubmitted(APP)).resolves.toBeUndefined();
        await expect(markAgreementOutcome({ applicationId: APP }, "failed")).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(2);
        warn.mockRestore();
    });
});
