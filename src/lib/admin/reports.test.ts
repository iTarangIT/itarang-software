import { describe, expect, it } from "vitest";
import { isUndefinedColumn, roleLabel } from "./reportHelpers";
import {
    MEETING_MODES,
    MEETING_MODE_LABELS,
    REPORT_LABELS,
    REPORT_TYPES,
} from "./types";

// E-220 added the two CEO leads reports. Most of their logic is SQL and is
// verified by running them against the database; what is unit-testable is the
// glue around it — and one piece of that glue has already failed silently once.

describe("isUndefinedColumn", () => {
    // The bug this exists for: Drizzle wraps the driver error in its own
    // "Failed query" Error, which carries NO `code`. Checking only the top
    // level matched nothing, so the E-220 fallback never fired and the whole
    // report 500'd on any environment without the migration.
    it("finds the pg code on a wrapped cause", () => {
        const driver = Object.assign(new Error("column v.meeting_mode does not exist"), {
            code: "42703",
        });
        const wrapped = new Error("Failed query: SELECT ...", { cause: driver });
        expect(isUndefinedColumn(wrapped)).toBe(true);
    });

    it("finds it on an unwrapped error too", () => {
        expect(isUndefinedColumn(Object.assign(new Error("x"), { code: "42703" }))).toBe(true);
    });

    it("walks more than one level of cause", () => {
        const inner = Object.assign(new Error("inner"), { code: "42703" });
        const mid = new Error("mid", { cause: inner });
        expect(isUndefinedColumn(new Error("outer", { cause: mid }))).toBe(true);
    });

    // A missing TABLE (42P01) or any other failure must still propagate —
    // swallowing those would turn a real breakage into a silently empty report.
    it("does not match other postgres errors", () => {
        expect(isUndefinedColumn(Object.assign(new Error("x"), { code: "42P01" }))).toBe(false);
        expect(isUndefinedColumn(new Error("plain"))).toBe(false);
        expect(isUndefinedColumn(null)).toBe(false);
        expect(isUndefinedColumn(undefined)).toBe(false);
    });

    it("terminates on a self-referential cause", () => {
        const e: { code?: string; cause?: unknown } = { code: "XX000" };
        e.cause = e;
        expect(isUndefinedColumn(e)).toBe(false);
    });
});

describe("roleLabel", () => {
    it("names the two populations the funnel report separates", () => {
        expect(roleLabel("inside_sales_rep")).toBe("Inside Sales");
        expect(roleLabel("sales_manager")).toBe("Sales Manager");
        expect(roleLabel("asm")).toBe("ASM");
    });

    // An unmapped role shows its raw value rather than blank: a new role should
    // look unfamiliar, not look like missing data.
    it("falls back to the raw role", () => {
        expect(roleLabel("service_engineer")).toBe("service_engineer");
    });

    it("renders a null role as a dash", () => {
        expect(roleLabel(null)).toBe("—");
    });
});

describe("report registry", () => {
    // The route validates ?type against REPORT_TYPES and the UI labels from
    // REPORT_LABELS. If they drift, a report is reachable but renders untitled.
    it("labels every report type", () => {
        for (const t of REPORT_TYPES) {
            expect(REPORT_LABELS[t], `missing label for ${t}`).toBeTruthy();
        }
        expect(Object.keys(REPORT_LABELS).sort()).toEqual([...REPORT_TYPES].sort());
    });

    it("includes the two E-220 reports", () => {
        expect(REPORT_TYPES).toContain("meetings_mtd");
        expect(REPORT_TYPES).toContain("funnel_by_owner");
    });
});

describe("meeting modes", () => {
    it("covers exactly the three modes the report has columns for", () => {
        expect([...MEETING_MODES]).toEqual(["ground", "calling", "whatsapp"]);
    });

    it("labels every mode", () => {
        for (const m of MEETING_MODES) expect(MEETING_MODE_LABELS[m]).toBeTruthy();
    });
});
