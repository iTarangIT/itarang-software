// "Finalised, not Won" (ID 75.4): the admin panel and the reps' queue chip
// share ONE predicate; the admin panel only adds the 2-day age floor.
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { finalisedNotWonSql } from "@/lib/leads/finalisedNotWon";

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

    it("the admin panel's version only adds the age floor, inside the same EXISTS", () => {
        const base = text(finalisedNotWonSql());
        const aged = text(finalisedNotWonSql({ minAgeDays: 2 }));
        expect(aged).toBe(
            base.replace(/\)$/, " AND c.dealer_decision_at < NOW() - INTERVAL '2 days')"),
        );
    });
});
