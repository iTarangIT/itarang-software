/** ID 185 — Fresh / Repeat / New to iTarang: the shared definition. */
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
    FIRST_VISIT_BY_ANYONE_SQL,
    FIRST_VISIT_BY_REP_SQL,
    freshRepeatJoins,
    freshRepeatSplit,
    repeatVisits,
    visitKind,
    visitedRowSql,
} from "../freshRepeat";

const render = (q: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(q).sql.replace(/\s+/g, " ").trim();

describe("visit shaping", () => {
    it("new wins over fresh, otherwise repeat", () => {
        expect(visitKind(true, true)).toBe("new");
        expect(visitKind(false, true)).toBe("fresh");
        expect(visitKind(false, false)).toBe("repeat");
        expect(visitKind(null, undefined)).toBe("repeat");
    });
    it("repeat = visits − fresh, so fresh + repeat = visits", () => {
        expect(repeatVisits(10, 4)).toBe(6);
        expect(repeatVisits(3, 5)).toBe(0);
        const s = freshRepeatSplit({ visits: 12, fresh_visits: 5, new_visits: 2 });
        expect(s.fresh + s.repeat).toBe(s.visits);
        expect(s.new_to_itarang).toBe(2);
    });
});

describe("visited-only SQL", () => {
    it("both first-visit subqueries count only visited rows", () => {
        for (const q of [FIRST_VISIT_BY_ANYONE_SQL, FIRST_VISIT_BY_REP_SQL]) {
            expect(render(q)).toContain("WHERE visit_status = 'visited' AND actual_visit_date IS NOT NULL");
        }
        expect(render(FIRST_VISIT_BY_REP_SQL)).toContain("GROUP BY asm_id, dealer_lead_id");
        expect(render(visitedRowSql("lv"))).toBe("lv.visit_status = 'visited' AND lv.actual_visit_date IS NOT NULL");
    });
    it("joins by name or inline", () => {
        expect(render(freshRepeatJoins())).toContain("LEFT JOIN fv fv ON fv.dealer_lead_id = v.dealer_lead_id");
        expect(render(freshRepeatJoins("v", true))).toContain("LEFT JOIN ( SELECT dealer_lead_id, MIN(actual_visit_date)");
    });
});
