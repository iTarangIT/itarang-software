import { describe, expect, it } from "vitest";

import { FILE_TOP_ROLES } from "@/lib/storage/fileRules";

import {
    CALL_REVIEW_ALL_ROLES,
    isOwnerAmong,
    mayReadCallReview,
    seesEveryCallReview,
    withoutCallReview,
} from "../callReviewRules";

describe("call reviews (ID 166 item 6, 18 Oct)", () => {
    it("Admin, Sales Head and CEO read every lead's call reviews — the file rule's top roles", () => {
        expect([...CALL_REVIEW_ALL_ROLES]).toEqual([...FILE_TOP_ROLES]);
        for (const role of ["admin", "ceo", "sales_head", "CEO"]) expect(seesEveryCallReview(role)).toBe(true);
    });

    it("everyone else reads them only on a lead they own", () => {
        for (const role of ["partner", "sales_insight", "sales_manager", "business_head", "asm", "inside_sales_rep"]) {
            expect(seesEveryCallReview(role)).toBe(false);
            expect(mayReadCallReview({ role, ownsLead: false })).toBe(false);
            expect(mayReadCallReview({ role, ownsLead: undefined })).toBe(false);
            expect(mayReadCallReview({ role, ownsLead: true })).toBe(true);
        }
        expect(mayReadCallReview({ role: null, ownsLead: false })).toBe(false);
    });

    it("isOwnerAmong never matches a missing id", () => {
        expect(isOwnerAmong("u-1", ["u-2", "u-1"])).toBe(true);
        expect(isOwnerAmong("u-1", [null, undefined, "u-2"])).toBe(false);
        expect(isOwnerAmong("", ["", null])).toBe(false);
        expect(isOwnerAmong(null, [null])).toBe(false);
    });

    it("withoutCallReview keeps the call but drops transcript, summary, recording and reasoning", () => {
        const call = {
            id: 1,
            status: "completed",
            intent_score: 70,
            intent_reason: "asked for price",
            transcript: "hello",
            summary: "keen",
            recording_url: "/api/files/call-recordings/bolna/c.mp3",
        };
        expect(withoutCallReview(call)).toEqual({
            id: 1,
            status: "completed",
            intent_score: 70,
            intent_reason: null,
            transcript: null,
            summary: null,
            recording_url: null,
            review_hidden: true,
        });
        expect(withoutCallReview(null)).toBeNull();
    });
});
