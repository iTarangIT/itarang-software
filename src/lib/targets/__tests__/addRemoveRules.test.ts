import { describe, expect, it } from "vitest";

import {
    isCeoTarget,
    mayAddTarget,
    mayRemoveTarget,
    removalAudience,
    TARGET_REMOVED_STATUS,
    TARGET_STATUSES,
    visibleStatuses,
} from "../rules";

// ID 189 — 16 Oct gap fixes: only the CEO creates and removes his targets,
// removal is soft, and each viewer sees only the version meant for them.

describe("adding a person or metric is the CEO's alone", () => {
    it("the CEO adds; the Sales Head, Admin and everyone else do not", () => {
        expect(mayAddTarget("ceo")).toBe(true);
        expect(mayAddTarget("CEO")).toBe(true);
        for (const r of ["sales_head", "admin", "business_head", "asm", "inside_sales_rep", "user", "", null, undefined]) {
            expect(mayAddTarget(r)).toBe(false);
        }
    });
});

describe("whose target is it", () => {
    const base = { createdByRole: "sales_head", postedByRole: "sales_head", ceoTarget: 0, pendingCeoTarget: null };

    it("a row the old flow let a Sales Head add on their own (CEO target 0) is not the CEO's", () => {
        expect(isCeoTarget(base)).toBe(false);
    });

    it("created by, or posted by, the CEO = the CEO's", () => {
        expect(isCeoTarget({ ...base, createdByRole: "ceo" })).toBe(true);
        expect(isCeoTarget({ ...base, postedByRole: "CEO" })).toBe(true);
    });

    it("a CEO number — in force, waiting or in draft — makes it the CEO's", () => {
        expect(isCeoTarget({ ...base, ceoTarget: 100 })).toBe(true);
        expect(isCeoTarget({ ...base, pendingCeoTarget: 0 })).toBe(true);
    });

    it("an unknown creator with a CEO target of 0 is not the CEO's", () => {
        expect(isCeoTarget({ createdByRole: null, postedByRole: null, ceoTarget: 0 })).toBe(false);
    });
});

describe("removing a target", () => {
    it("the CEO removes any target", () => {
        expect(mayRemoveTarget("ceo", true)).toBe(true);
        expect(mayRemoveTarget("ceo", false)).toBe(true);
    });

    it("the Sales Head / Admin never remove one the CEO set", () => {
        expect(mayRemoveTarget("sales_head", true)).toBe(false);
        expect(mayRemoveTarget("admin", true)).toBe(false);
    });

    it("the Sales Head / Admin may remove only a row that is not the CEO's", () => {
        expect(mayRemoveTarget("sales_head", false)).toBe(true);
        expect(mayRemoveTarget("admin", false)).toBe(true);
    });

    it("nobody else removes anything", () => {
        for (const r of ["business_head", "asm", "inside_sales_rep", "user", "", null]) {
            expect(mayRemoveTarget(r, false)).toBe(false);
        }
    });

    it("tells the member only if it had been pushed, the Sales Head once posted", () => {
        expect(removalAudience("draft")).toEqual({ member: false, salesHead: false });
        expect(removalAudience("pending_approval")).toEqual({ member: false, salesHead: true });
        expect(removalAudience("pushed")).toEqual({ member: true, salesHead: true });
        expect(removalAudience("accepted")).toEqual({ member: true, salesHead: true });
        expect(removalAudience("rejected")).toEqual({ member: true, salesHead: true });
    });
});

describe("who sees which rows", () => {
    it("nobody sees a removed row, and it is not a status anyone can filter on", () => {
        for (const v of ["ceo", "manager", "member"] as const) expect(visibleStatuses(v)).not.toContain(TARGET_REMOVED_STATUS);
        expect(TARGET_STATUSES as readonly string[]).not.toContain(TARGET_REMOVED_STATUS);
    });

    it("only the CEO sees his drafts", () => {
        expect(visibleStatuses("ceo")).toContain("draft");
        expect(visibleStatuses("manager")).not.toContain("draft");
        expect(visibleStatuses("member")).not.toContain("draft");
    });

    it("the member sees only what was pushed to them — not a target still with the Sales Head", () => {
        expect([...visibleStatuses("member")].sort()).toEqual(["accepted", "pushed", "rejected"]);
        expect(visibleStatuses("manager")).toContain("pending_approval");
    });
});
