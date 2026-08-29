import { describe, it, expect } from "vitest";
import { EXPENSE_DEPARTMENT_VALUES } from "@/lib/expenses";
import {
    departmentFromRules,
    resolveDepartment,
    VENDOR_DEPARTMENT_RULES,
} from "./departmentRules";

// E-224. The bug these rules fix was not a wrong bucket — buckets were right —
// but a wrong DEPARTMENT: Trontek battery invoices were filed under Tech, so the
// CEO's by-department strip read ₹38.42L of "Tech" against ₹75K of Operations.
//
// The property being pinned is the invariant, stated once here and enforced in
// three places (prompt, resolver, backfill):
//
//     bucket = 'rm'  ⇒  department ≠ 'tech'

describe("departmentFromRules — vendor rules", () => {
    it("matches a vendor fragment anywhere in the name, case-insensitively", () => {
        expect(departmentFromRules({ vendor: "Trontek Electronics Limited" })?.department).toBe("ops");
        expect(departmentFromRules({ vendor: "TRONTEK" })?.department).toBe("ops");
        expect(departmentFromRules({ vendor: "  trontek  " })?.department).toBe("ops");
    });

    it("classifies the component suppliers actually seen in the live folder", () => {
        expect(departmentFromRules({ vendor: "Ecostar Innovation Pvt Ltd" })?.department).toBe("ops");
        expect(departmentFromRules({ vendor: "AmpFusion Battery" })?.department).toBe("ops");
        expect(departmentFromRules({ vendor: "Ayansh Engineering" })?.department).toBe("ops");
        expect(departmentFromRules({ vendor: "Trinity Electric Vehicles Pvt Ltd" })?.department).toBe("ops");
    });

    it("reports which rule fired", () => {
        expect(departmentFromRules({ vendor: "Trontek Electronics Limited" })?.rule).toBe("vendor:trontek");
    });

    it("stays out of the way when nothing matches", () => {
        expect(departmentFromRules({})).toBeNull();
        expect(departmentFromRules({ vendor: "Some Unknown Supplier" })).toBeNull();
        // A SaaS vendor has no rule — the model already gets these right, and a
        // rule for every vendor would be a second taxonomy to keep true.
        expect(departmentFromRules({ vendor: "Anthropic PBC" })).toBeNull();
    });

    it("only ever names a real department", () => {
        for (const [, department] of VENDOR_DEPARTMENT_RULES) {
            expect(EXPENSE_DEPARTMENT_VALUES).toContain(department);
        }
    });
});

describe("departmentFromRules — the bucket=rm invariant", () => {
    it("files raw material under ops even for an unknown vendor", () => {
        const match = departmentFromRules({ vendor: "New Cell Supplier Co", bucket: "rm" });
        expect(match?.department).toBe("ops");
        expect(match?.rule).toBe("bucket:rm");
    });

    it("does NOT claim the reverse for tech spend", () => {
        // A Canva subscription bought by marketing is bucket tech and department
        // marketing. Forcing tech here would break a different number to fix this one.
        expect(departmentFromRules({ vendor: "Canva Pty Ltd", bucket: "tech" })).toBeNull();
        expect(departmentFromRules({ bucket: "misc" })).toBeNull();
        expect(departmentFromRules({ bucket: "others" })).toBeNull();
    });
});

describe("resolveDepartment — precedence", () => {
    it("beats the model when a rule matches", () => {
        // This is the exact shape of the reported bug: the extractor said "tech"
        // for a Trontek battery invoice, confidently.
        const resolved = resolveDepartment({
            vendor: "Trontek Electronics Limited",
            description: "Lithium battery pack 60V",
            bucket: "rm",
            aiDepartment: "tech",
            aiConfidence: 0.95,
        });
        expect(resolved.department).toBe("ops");
        expect(resolved.source).toBe("rule");
        expect(resolved.detail).toBe("vendor:trontek");
    });

    it("keeps the model's answer when no rule applies", () => {
        const resolved = resolveDepartment({
            vendor: "Amazon Web Services",
            bucket: "tech",
            aiDepartment: "tech",
            aiConfidence: 0.9,
        });
        expect(resolved.department).toBe("tech");
        expect(resolved.source).toBe("ai");
    });

    it("falls back to ops below the confidence floor", () => {
        const resolved = resolveDepartment({
            vendor: "Unknown Supplier",
            aiDepartment: "marketing",
            aiConfidence: 0.2,
        });
        expect(resolved.department).toBe("ops");
        expect(resolved.source).toBe("default");
        expect(resolved.detail).toContain("marketing");
    });

    it("falls back to ops when the model returns nothing usable", () => {
        expect(resolveDepartment({}).department).toBe("ops");
        expect(resolveDepartment({ aiDepartment: "engineering" }).department).toBe("ops");
        expect(resolveDepartment({ aiDepartment: null }).source).toBe("default");
    });

    it("is stable — the same invoice resolves the same way every time", () => {
        const input = {
            vendor: "Trontek Electronics Limited",
            description: "EV Battery Purchase",
            bucket: "rm" as const,
        };
        const a = resolveDepartment({ ...input, aiDepartment: "tech" });
        const b = resolveDepartment({ ...input, aiDepartment: "ops" });
        const c = resolveDepartment({ ...input, aiDepartment: null });
        expect([a.department, b.department, c.department]).toEqual(["ops", "ops", "ops"]);
    });

    it("never returns a department outside the taxonomy", () => {
        const cases = [
            resolveDepartment({}),
            resolveDepartment({ vendor: "Trontek" }),
            resolveDepartment({ bucket: "rm" }),
            resolveDepartment({ aiDepartment: "finance", aiConfidence: 1 }),
        ];
        for (const c of cases) {
            expect(EXPENSE_DEPARTMENT_VALUES).toContain(c.department);
        }
    });
});
