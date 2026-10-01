import { describe, expect, it } from "vitest";
import { ownerAtClose } from "../closingOwner";
import { ownerConversionRate } from "@/lib/admin/reportHelpers";

// Tracker ID 117 — conversions belong to the closing owner.

describe("ownerAtClose", () => {
    it("nothing moved since the close → the current owner", () => {
        expect(ownerAtClose({ currentOwnerId: "rep", movedAfter: false, firstAfterFrom: null, lastBeforeTo: null })).toEqual({
            ownerId: "rep",
            evidence: "not_moved_since",
        });
        // …and the last recorded hop before the close agrees.
        expect(ownerAtClose({ currentOwnerId: "rep", movedAfter: false, firstAfterFrom: null, lastBeforeTo: "rep" }).evidence).toBe(
            "not_moved_since",
        );
    });

    it("nothing moved since, but the last hop names someone else → unknown, not a guess", () => {
        expect(ownerAtClose({ currentOwnerId: "rep", movedAfter: false, firstAfterFrom: null, lastBeforeTo: "asm" })).toEqual({
            ownerId: null,
            evidence: "unknown",
        });
    });

    it("an unowned lead that never moved has no owner to credit", () => {
        expect(ownerAtClose({ currentOwnerId: null, movedAfter: false, firstAfterFrom: null, lastBeforeTo: null })).toEqual({
            ownerId: null,
            evidence: "not_moved_since",
        });
    });

    it("reassigned after the close → who it was taken from, not who has it now", () => {
        expect(ownerAtClose({ currentOwnerId: "new-rep", movedAfter: true, firstAfterFrom: "closer", lastBeforeTo: "someone" })).toEqual({
            ownerId: "closer",
            evidence: "hop_after",
        });
    });

    it("moved after the close with no 'from' recorded → the last recorded hop before it", () => {
        expect(ownerAtClose({ currentOwnerId: "new-rep", movedAfter: true, firstAfterFrom: null, lastBeforeTo: "closer" })).toEqual({
            ownerId: "closer",
            evidence: "hop_before",
        });
    });

    // The lead that broke the first version: claimed by a rep (recorded hop),
    // transferred to an ASM before hops were recorded, converted by the ASM,
    // later handed back to the rep with no "from". The last move before the
    // close is the unrecorded transfer, so lastBeforeTo is null — and the ASM
    // keeps the conversion.
    it("an unrecorded transfer next to the close → unknown; the closing owner is left alone", () => {
        expect(ownerAtClose({ currentOwnerId: "rep", movedAfter: true, firstAfterFrom: null, lastBeforeTo: null })).toEqual({
            ownerId: null,
            evidence: "unknown",
        });
    });
});

describe("ownerConversionRate (Funnel by Owner)", () => {
    it("is conversions over leads worked, as a whole percent", () => {
        expect(ownerConversionRate(3, 40)).toBe(8);
        expect(ownerConversionRate(0, 40)).toBe(0);
    });

    it("is blank with no work in the period — a late approval of an earlier win", () => {
        expect(ownerConversionRate(1, 0)).toBeNull();
    });

    it("never reads above 100", () => {
        expect(ownerConversionRate(3, 2)).toBe(100);
    });
});
