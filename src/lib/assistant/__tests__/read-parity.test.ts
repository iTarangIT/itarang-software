import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

// Round 2, Phase B — the read tools say what the screens say. Pure helpers
// only; the DB-backed parity (queue totals, team scope, cards) is
// scripts/verify-assistant-parity.ts.

vi.mock("@/lib/db", () => ({ db: { execute: vi.fn(async () => []) } }));

const { statusLabel, istIso } = await import("../format");
const { normalizeSearch, assistantSearchClause } = await import("../tools/read/searchLead");
const { filterCatalogue } = await import("../tools/quotes");
const { shapeNumbers, METRIC_DEFINITIONS } = await import("../tools/read/myNumbers");
const { toLeadSummary } = await import("../tools/leads");
const { LEAD_STATUS_LABEL } = await import("@/lib/leads/queueFilters");
const { LEAD_STATUS } = await import("@/lib/lifecycle/transitions");
import type { AssistantUser } from "../types";

const ISR: AssistantUser = { id: "isr-1", name: "Priya", role: "inside_sales_rep" };
const ASM: AssistantUser = { id: "asm-1", name: "Rahul", role: "asm" };

describe("statusLabel = the screens' LEAD_STATUS_LABEL", () => {
    it("every lifecycle status reads as on the CRM screens", () => {
        for (const s of LEAD_STATUS) expect(statusLabel(s), s).toBe(LEAD_STATUS_LABEL[s]);
        expect(statusLabel("Transferred_to_ASM")).toBe("Awaiting field visit");
        expect(statusLabel("Assigned_Not_Contacted")).toBe("Assigned");
    });

    it("an unknown code falls back to spaces; null is 'none'", () => {
        expect(statusLabel("Some_New_State")).toBe("Some New State");
        expect(statusLabel(null)).toBe("none");
        expect(statusLabel(undefined)).toBe("none");
    });
});

describe("istIso — timestamps reach the model as IST", () => {
    it("Date, ISO and Postgres text → +05:30 wall clock", () => {
        expect(istIso(new Date("2026-10-15T04:30:00Z"))).toBe("2026-10-15T10:00:00+05:30");
        expect(istIso("2026-10-15T04:30:00.000Z")).toBe("2026-10-15T10:00:00+05:30");
        expect(istIso("2026-09-19 08:35:08.84+00")).toBe("2026-09-19T14:05:08+05:30");
        // Crosses midnight into the IST day.
        expect(istIso("2026-10-15T20:00:00Z")).toBe("2026-10-16T01:30:00+05:30");
    });

    it("a date-only value is unchanged; empty is null; junk stays text", () => {
        expect(istIso("2026-10-15")).toBe("2026-10-15");
        expect(istIso(null)).toBeNull();
        expect(istIso("")).toBeNull();
        expect(istIso("soon")).toBe("soon");
    });

    it("round-trips: the IST string is the same instant", () => {
        const at = new Date("2026-10-15T04:30:00Z");
        expect(new Date(istIso(at)!).getTime()).toBe(at.getTime());
    });
});

describe("search_lead phone normalisation", () => {
    it("drops +91 / 0091 / a trunk 0, keeps a 10-digit number that starts with 91", () => {
        expect(normalizeSearch("+91 98123 45678")).toBe("9812345678");
        expect(normalizeSearch("+91-98123-45678")).toBe("9812345678");
        expect(normalizeSearch("0091 98123 45678")).toBe("9812345678");
        expect(normalizeSearch("919812345678")).toBe("9812345678");
        expect(normalizeSearch("098123 45678")).toBe("9812345678");
        expect(normalizeSearch("98123 45678")).toBe("9812345678");
        expect(normalizeSearch("9198765432")).toBe("9198765432");
        // A short partial keeps its digits.
        expect(normalizeSearch("+91 98123")).toBe("9198123");
        expect(normalizeSearch("Gupta Motors")).toBe("Gupta Motors");
    });

    it("an all-digit query also matches the phone digits-only; text uses the screens' clause alone", () => {
        const dialect = new PgDialect();
        const digits = dialect.sqlToQuery(assistantSearchClause("9812345678"));
        expect(digits.sql).toMatch(/ILIKE/);
        expect(digits.sql).toMatch(/regexp_replace\(COALESCE\(dl\.phone, ''\), '\[\^0-9\]', '', 'g'\) LIKE/);
        expect(digits.params).toContain("%9812345678%");
        const text = dialect.sqlToQuery(assistantSearchClause("Gupta"));
        expect(text.sql).not.toMatch(/regexp_replace/);
    });
});

describe("product_catalogue — trailing zeros", () => {
    const rows = [
        { product_id: "b-105", asset_type: "battery" as const, product_name: "LFP Pack", model_id: "ITB-1", detail: "51.20V · 105.00Ah · LFP" },
        { product_id: "b-80", asset_type: "battery" as const, product_name: "LFP Pack", model_id: "ITB-2", detail: "51.20V · 80.00Ah · LFP" },
        { product_id: "b-1", asset_type: "battery" as const, product_name: "Cell", model_id: "C-1", detail: "1.05V" },
    ];
    it('"51.2V 105Ah" finds a master stored as 51.20 / 105.00', () => {
        expect(filterCatalogue(rows, "51.2V 105Ah").map((r) => r.product_id)).toEqual(["b-105"]);
        expect(filterCatalogue(rows, "51.20v 105.00ah").map((r) => r.product_id)).toEqual(["b-105"]);
        expect(filterCatalogue(rows, "51.2v").map((r) => r.product_id)).toEqual(["b-105", "b-80"]);
        // A significant zero is not trimmed.
        expect(filterCatalogue(rows, "1.05v").map((r) => r.product_id)).toEqual(["b-1"]);
    });
});

describe("my_numbers shape", () => {
    const dash = {
        as_of_date: "2026-10-15",
        totals: { visits: 12, unique_visits: 9, new_visits: 3, calls: 40, dealers_called: 30, converted: 1, new_hot: 0, hot_converted: 0 },
        snapshot: { visits_yesterday: 0, calls_yesterday: 0, planned_visits_today: 1, planned_visits_next_7_days: 4 },
        interest: { rows: [{ interest_level: "hot", total: 2 }], ageing_basis: "" },
    } as never;
    const target = (metric: string, p: Record<string, unknown>) =>
        ({ metric, metric_label: metric, status: "accepted", progress: { remaining: null, required_per_day: null, rag: "green", ...p } }) as never;

    it("a per-day target is reported as a DAILY target, not a monthly one", () => {
        const out = shapeNumbers(ISR, "this_month", { from: "2026-10-01", to: "2026-10-15" }, dash, [
            target("calls_per_day", { monthly_target: 30, mtd_target: 30, actual: 32, pct_of_mtd: 107 }),
            target("hot_to_ground", { monthly_target: 20, mtd_target: 10, actual: 8, pct_of_mtd: 80 }),
        ]);
        const [perDay, monthly] = out.targets as Record<string, unknown>[];
        expect(perDay).toMatchObject({ metric: "calls_per_day", daily_target: 30, actual_per_day: 32, pct_of_target: 107 });
        expect(perDay).not.toHaveProperty("monthly_target");
        expect(monthly).toMatchObject({ metric: "hot_to_ground", monthly_target: 20, mtd_target: 10 });
    });

    it("the CRM link opens the performance page on the same range", () => {
        const out = shapeNumbers(ASM, "last_month", { from: "2026-09-01", to: "2026-09-30" }, dash, []);
        expect(out.crm_url).toMatch(/\/asm\/performance\?from=2026-09-01&to=2026-09-30$/);
    });

    it("last month marks the snapshot figures as of now; this month does not", () => {
        expect(shapeNumbers(ASM, "last_month", { from: "2026-09-01", to: "2026-09-30" }, dash, []).as_of_now_note).toMatch(
            /interest and planned_visits are as of now/,
        );
        expect(shapeNumbers(ISR, "last_month", { from: "2026-09-01", to: "2026-09-30" }, dash, []).as_of_now_note).toMatch(/^interest is as of now/);
        expect(shapeNumbers(ASM, "this_month", { from: "2026-10-01", to: "2026-10-15" }, dash, [])).not.toHaveProperty("as_of_now_note");
    });

    it("every returned figure carries a definition, worded for any period", () => {
        const asm = shapeNumbers(ASM, "this_month", { from: "2026-10-01", to: "2026-10-15" }, dash, []);
        const defs = asm.definitions as Record<string, string>;
        for (const k of [...Object.keys(asm.activity as object), "interest", "planned_visits"]) expect(defs[k], k).toBeTruthy();
        expect(defs.visits).toMatch(/completed.*actual visit date.*one per dealer per day/);
        expect(shapeNumbers(ISR, "this_month", { from: "2026-10-01", to: "2026-10-15" }, dash, []).definitions).not.toHaveProperty("planned_visits");
        for (const [k, v] of Object.entries(METRIC_DEFINITIONS)) expect(v, k).not.toMatch(/this month/);
    });
});

describe("toLeadSummary", () => {
    const row = {
        id: "DL-9", shop_name: "ABC", lead_status: "Transferred_to_ASM", current_owner_id: "asm-1",
        last_touchpoint_at: "2026-09-30T06:30:00.000Z", next_follow_up_at: "2026-09-26T05:30:00.000Z", scheduled_date: "2026-09-27",
    };

    it("status_label is the screens' label next to the raw status", () => {
        const s = toLeadSummary(row, ISR);
        expect(s.status).toBe("Transferred_to_ASM");
        expect(s.status_label).toBe("Awaiting field visit");
        expect(toLeadSummary({ id: "DL-1" }, ISR).status_label).toBeNull();
    });

    it("timestamps in IST; an ISR's next date is the follow-up", () => {
        const s = toLeadSummary(row, ISR);
        expect(s.next_date).toBe("2026-09-26T11:00:00+05:30");
        expect(s.last_activity_at).toBe("2026-09-30T12:00:00+05:30");
    });

    it("an ASM's next date is the latest visit only while it is still open", () => {
        expect(toLeadSummary({ ...row, visit_status: "scheduled" }, ASM).next_date).toBe("2026-09-27");
        expect(toLeadSummary({ ...row, visit_status: "pending_scheduling" }, ASM).next_date).toBe("2026-09-27");
        expect(toLeadSummary({ ...row, visit_status: "visited" }, ASM).next_date).toBeNull();
        expect(toLeadSummary({ ...row, visit_status: "cancelled" }, ASM).next_date).toBeNull();
        expect(toLeadSummary({ ...row, visit_status: null }, ASM).next_date).toBeNull();
    });
});
