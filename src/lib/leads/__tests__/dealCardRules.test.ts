import { describe, expect, it } from "vitest";

import {
    DealCardSchema,
    dealCardChips,
    dealCardLockedBy,
    dealCardMissingMessage,
    normaliseDealCard,
    parseDealCard,
    sameDealCard,
} from "../dealCardRules";

const card = { onboarding_fee: 25000, batteries_per_month: 10, finance_files_per_month: 4 };

describe("deal card (ID 172)", () => {
    it("needs all three answers, batteries ≥ 1, files ≥ 0", () => {
        expect(DealCardSchema.safeParse(card).success).toBe(true);
        expect(DealCardSchema.safeParse({ ...card, batteries_per_month: 0 }).success).toBe(false);
        expect(DealCardSchema.safeParse({ ...card, finance_files_per_month: 0 }).success).toBe(true);
        expect(DealCardSchema.safeParse({ onboarding_fee: 100 }).success).toBe(false);
    });

    it("a waived fee needs a reason", () => {
        expect(DealCardSchema.safeParse({ ...card, onboarding_fee: 0 }).success).toBe(false);
        expect(DealCardSchema.safeParse({ ...card, onboarding_fee: 0, fee_waived_reason: "strategic dealer" }).success).toBe(true);
    });

    it("keeps the waived reason only when the fee is 0", () => {
        expect(normaliseDealCard({ ...card, fee_waived_reason: "x" }).fee_waived_reason).toBeNull();
        expect(sameDealCard({ ...card, fee_waived_reason: "x" }, card)).toBe(true);
        expect(sameDealCard(card, { ...card, batteries_per_month: 11 })).toBe(false);
    });

    it("reads a row's to_jsonb fields; missing fields = no card", () => {
        expect(
            parseDealCard({
                onboarding_fee: "25000.00",
                fee_waived_reason: null,
                expected_batteries_per_month: 10,
                expected_finance_files_per_month: 4,
            }),
        ).toEqual({ ...card, fee_waived_reason: null });
        expect(parseDealCard({ onboarding_fee: null, expected_batteries_per_month: null })).toBeNull();
        expect(parseDealCard(null)).toBeNull();
    });

    it("locks on a CEO approval (a person) or the dealer's yes — not on auto-approval", () => {
        expect(dealCardLockedBy({ approval_status: "approved", approved_by: "u1", dealer_decision: null })).toBe("ceo");
        expect(dealCardLockedBy({ approval_status: "approved", approved_by: null, dealer_decision: null })).toBeNull();
        expect(dealCardLockedBy({ approval_status: "approved", approved_by: null, dealer_decision: "approved" })).toBe("dealer");
        expect(dealCardLockedBy({ approval_status: "pending", approved_by: null, dealer_decision: null })).toBeNull();
    });

    it("chips: fee or Waived, then the two estimates", () => {
        expect(dealCardChips(card).map(([k]) => k)).toEqual(["Onboarding fee", "Batteries / month", "Finance files / month"]);
        expect(dealCardChips({ ...card, onboarding_fee: 0, fee_waived_reason: "big order" })[0][1]).toBe("Waived — big order");
        expect(dealCardChips(null)).toEqual([]);
    });
});

describe("ID 186: the missing-card refusal says why", () => {
    it("a brand-new dealer (or no check) is told it is not onboarded", () => {
        expect(dealCardMissingMessage(false)).toMatch(/^This dealer is not onboarded yet/);
        expect(dealCardMissingMessage(undefined)).toMatch(/^This dealer is not onboarded yet/);
    });
    it("an onboarded dealer (Admin / partner saving) is not told it is not onboarded", () => {
        expect(dealCardMissingMessage(true)).not.toMatch(/not onboarded/);
        expect(dealCardMissingMessage(true)).toMatch(/Only ISR, ASM and Sales Head may skip it/);
    });
});
