import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { effectiveDoorSql } from "../leadSourceDoorSql";
import { effectiveDoor, LEGACY_SOURCE_DOOR, leadSourceLabel } from "../leadSourceVocab";
import { transferCredit } from "@/lib/reports/metricDefinitions";

const render = (q: ReturnType<typeof sql>) => new PgDialect().sqlToQuery(q);

// HANDOVER-A31 — the "Lead source" filter uses the same legacy fallback as the column.
describe("effective door", () => {
    it("stamped door wins, else the legacy source's implied door, else null", () => {
        expect(effectiveDoor("rep_create", "google_places")).toBe("rep_create");
        expect(effectiveDoor(null, "google_places")).toBe("scraper");
        expect(effectiveDoor(null, "dealer_referral")).toBeNull();
        expect(effectiveDoor(null, "toString")).toBeNull();
        expect(effectiveDoor(null, null)).toBeNull();
    });

    it("the column label follows the effective door", () => {
        expect(leadSourceLabel(null, "manual_upload_lead")).toBe("Bulk upload");
        expect(leadSourceLabel(null, "dealer_referral")).toBe("dealer referral");
        expect(leadSourceLabel("scraper", null)).toBe("Scraper");
    });

    it("the SQL maps every legacy source to the same door as effectiveDoor()", () => {
        const q = render(effectiveDoorSql(sql`dl`));
        expect(q.sql).toContain("COALESCE(to_jsonb(dl) ->> 'source_door', (CASE dl.source");
        const pairs = Object.entries(LEGACY_SOURCE_DOOR);
        expect(q.params).toEqual(pairs.flat());
        for (const [legacy, door] of pairs) expect(effectiveDoor(null, legacy)).toBe(door);
    });
});

// HANDOVER-A31 — a bulk assign of an unowned lead is nobody's "Hot to field".
describe("transferCredit", () => {
    it("credits the previous owner; old rows the presser; a recorded move with no previous owner nobody", () => {
        const q = render(transferCredit(sql`t`)).sql;
        expect(q).toBe("COALESCE(t.from_owner_id, CASE WHEN t.to_owner_id IS NULL THEN t.performed_by END)");
    });
});
