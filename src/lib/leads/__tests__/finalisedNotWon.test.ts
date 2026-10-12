// "Finalised, not Won" (ID 75.4): the admin panel and the reps' queue chip
// share ONE predicate; the admin panel only adds the said_yes_not_won
// working-day floor (ID 85 — the CEO card's limit).
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("@/lib/db", () => ({ db: {} }));
const { finalisedNotWonSql } = await import("@/lib/leads/finalisedNotWon");

const text = (q: ReturnType<typeof finalisedNotWonSql>) =>
    new PgDialect().sqlToQuery(q).sql.replace(/\s+/g, " ").trim();

describe("finalisedNotWonSql", () => {
    it("is Commercials_Finalised + an approved, gate-cleared, non-withdrawn dealer decision", () => {
        const s = text(finalisedNotWonSql());
        expect(s).toContain("dl.lead_status = 'Commercials_Finalised'");
        expect(s).toContain("dl.is_active IS NOT FALSE");
        expect(s).toContain("c.dealer_decision = 'approved'");
        expect(s).toContain("COALESCE(c.approval_status, 'approved') = 'approved'");
        expect(s).toContain("c.withdrawn_at IS NULL");
        expect(s).not.toContain("dealer_decision_at");
    });

    it("the admin panel's version only appends a working-day floor on the dealer's latest yes", () => {
        const base = text(finalisedNotWonSql());
        const aged = text(finalisedNotWonSql({ overWorkingDays: 1 }));
        expect(aged.startsWith(base)).toBe(true);
        const extra = aged.slice(base.length);
        expect(extra).toContain("MAX(c.dealer_decision_at)");
        expect(extra).toContain("holiday_calendar");
        expect(extra).toMatch(/::int > 1$/);
    });
});
