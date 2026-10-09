import { describe, expect, it } from "vitest";

import type { DealerHealthRow } from "@/lib/dealers/accountHealth";
import {
    ceoRecipients,
    dormancyKey,
    newlyDormant,
    planOrangeNudges,
    planWinback,
    type ReminderUser,
} from "@/lib/accounts/reorderReminderPlan";
import { isTestLogin } from "@/lib/users/testLogin";

function row(p: Partial<DealerHealthRow> & Pick<DealerHealthRow, "key" | "bucket">): DealerHealthRow {
    return {
        account_id: p.key,
        lead_id: null,
        came_through: null,
        dealer: p.key,
        gstin: null,
        city: null,
        state: null,
        business_type: null,
        owner_id: null,
        owner_name: null,
        converted_on: null,
        first_order: null,
        last_order: "2026-08-01",
        days_since_last_order: 40,
        days_since_conversion: 200,
        orders: 2,
        revenue_90d: 0,
        revenue_lifetime: 1000,
        avg_reorder_days: 20,
        closed_reason: null,
        order_claim: null,
        ...p,
    };
}

const user = (id: string, role: string, email: string | null = `${id}@itarang.com`, is_active = true): ReminderUser => ({
    id,
    email,
    name: id,
    role,
    is_active,
});

const USERS = [
    user("rep1", "asm"),
    user("rep2", "inside_sales_rep"),
    user("gone", "asm", "gone@itarang.com", false),
    user("sh", "sales_head"),
    user("e2esh", "sales_head", "e2e-sh@itarang.com"),
    user("ceo1", "ceo"),
    user("ceo2", "ceo", "x@e2e.itarang.local"),
];

describe("ID 5 — reorder reminder plan", () => {
    it("recognises the automated test logins", () => {
        expect(isTestLogin("e2e-sh@itarang.com")).toBe(true);
        expect(isTestLogin("itarang_super_admin@e2e.itarang.local")).toBe(true);
        expect(isTestLogin("anirudh@itarang.com")).toBe(false);
        expect(isTestLogin("e2emma@itarang.com")).toBe(false);
    });

    it("Orange: one mail per owner, unowned and departed-owner dealers to the Sales Head only", () => {
        const rows = [
            row({ key: "a", bucket: "orange", owner_id: "rep1", days_since_last_order: 33 }),
            row({ key: "b", bucket: "orange", owner_id: "rep1", days_since_last_order: 44 }),
            row({ key: "c", bucket: "orange", owner_id: "rep2" }),
            row({ key: "d", bucket: "orange", owner_id: null }),
            row({ key: "e", bucket: "orange", owner_id: "gone" }),
            row({ key: "f", bucket: "red", owner_id: "rep1" }),
            row({ key: "g", bucket: "active", owner_id: "rep2" }),
            row({ key: "h", bucket: "cooling", owner_id: "rep2" }),
            row({ key: "i", bucket: "closed", owner_id: "rep2" }),
        ];
        const mails = planOrangeNudges(rows, USERS);
        const by = new Map(mails.map((m) => [m.recipientId, m]));
        expect([...by.keys()].sort()).toEqual(["rep1", "rep2", "sh"]);
        // Most overdue first.
        expect(by.get("rep1")!.dealers.map((d) => d.key)).toEqual(["b", "a"]);
        expect(by.get("rep2")!.dealers.map((d) => d.key)).toEqual(["c"]);
        expect(by.get("sh")!.dealers.map((d) => d.key).sort()).toEqual(["d", "e"]);
        expect(by.get("sh")!.includesUnowned).toBe(true);
    });

    it("Orange: nothing unowned means no Sales Head mail", () => {
        const mails = planOrangeNudges([row({ key: "a", bucket: "orange", owner_id: "rep1" })], USERS);
        expect(mails.map((m) => m.recipientId)).toEqual(["rep1"]);
    });

    it("Win-back: owners get their own Dormant dealers, the Sales Head gets them all", () => {
        const rows = [
            row({ key: "a", bucket: "dormant", owner_id: "rep1", days_since_last_order: 70 }),
            row({ key: "b", bucket: "dormant", owner_id: null, days_since_last_order: 90 }),
            row({ key: "c", bucket: "orange", owner_id: "rep1" }),
        ];
        const by = new Map(planWinback(rows, USERS).map((m) => [m.recipientId, m]));
        expect([...by.keys()].sort()).toEqual(["rep1", "sh"]);
        expect(by.get("rep1")!.dealers.map((d) => d.key)).toEqual(["a"]);
        expect(by.get("sh")!.dealers.map((d) => d.key)).toEqual(["b", "a"]);
        expect(planWinback([row({ key: "a", bucket: "red" })], USERS)).toEqual([]);
    });

    it("CEO: alerted once per dormancy, to real CEO logins only", () => {
        const a = row({ key: "a", bucket: "dormant", last_order: "2026-07-01" });
        const b = row({ key: "b", bucket: "dormant", last_order: "2026-06-01" });
        expect(newlyDormant([a, b], new Set([dormancyKey(a)])).map((r) => r.key)).toEqual(["b"]);
        // A new invoice then a new lapse is a new dormancy.
        const again = { ...a, last_order: "2026-08-01" };
        expect(newlyDormant([again], new Set([dormancyKey(a)])).map((r) => r.key)).toEqual(["a"]);
        expect(ceoRecipients(USERS).map((u) => u.id)).toEqual(["ceo1"]);
    });
});
