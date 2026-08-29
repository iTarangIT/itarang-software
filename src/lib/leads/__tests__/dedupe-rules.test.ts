// Unit tests for the shared dedupe engine (E-224).
//
// These cover the two things that used to differ between the four entry paths
// into dealer_leads: how a phone number is normalised, and what a phone match
// means. Both are now single implementations, so a regression here is a
// regression everywhere at once — which is exactly why they're worth pinning.

import { describe, expect, it } from "vitest";
import {
    classifyAgainstExisting,
    normalizePhone,
    type ExistingLead,
} from "../dedupe-rules";

const lead = (over: Partial<ExistingLead> = {}): ExistingLead => ({
    id: "DL-1",
    phone: "+919876543210",
    lead_status: null,
    city: "Ujjain",
    state: "Madhya Pradesh",
    ...over,
});

describe("normalizePhone", () => {
    it("accepts a plain 10-digit mobile", () => {
        expect(normalizePhone("9876543210")).toBe("+919876543210");
    });

    it("strips formatting — spaces, dashes, brackets, +91", () => {
        for (const input of [
            "+91 98765 43210",
            "98765-43210",
            "(+91) 9876543210",
            " 9876543210 ",
            "+91-98765-43210",
        ]) {
            expect(normalizePhone(input)).toBe("+919876543210");
        }
    });

    it("handles the 91- and 0-prefixed forms", () => {
        expect(normalizePhone("919876543210")).toBe("+919876543210");
        expect(normalizePhone("09876543210")).toBe("+919876543210");
    });

    it("is idempotent — normalising an already-normalised number is a no-op", () => {
        const once = normalizePhone("9876543210")!;
        expect(normalizePhone(once)).toBe(once);
    });

    // The strictness is deliberate: anything stored in a non-canonical shape
    // can never be matched by any importer again, so these must fail loudly at
    // validation rather than be coerced into something plausible.
    it("rejects numbers that are not Indian mobiles", () => {
        expect(normalizePhone("5876543210")).toBeNull(); // leading 5
        expect(normalizePhone("1234567890")).toBeNull(); // leading 1
        expect(normalizePhone("987654321")).toBeNull(); // 9 digits
        expect(normalizePhone("98765432101")).toBeNull(); // 11, no leading 0
        expect(normalizePhone("0512 2345678")).toBeNull(); // landline
        expect(normalizePhone("")).toBeNull();
        expect(normalizePhone("not a phone")).toBeNull();
    });

    // This is the case the old lax normalisers got wrong: they turned an
    // 11-digit 0-prefixed LANDLINE into +915512345678 and stored it.
    it("rejects an 11-digit 0-prefixed landline the lax normaliser accepted", () => {
        expect(normalizePhone("05512345678")).toBeNull();
    });

    it("tolerates null/undefined input without throwing", () => {
        expect(normalizePhone(undefined as unknown as string)).toBeNull();
        expect(normalizePhone(null as unknown as string)).toBeNull();
    });
});

describe("classifyAgainstExisting", () => {
    it("returns `valid` when nothing exists for the phone", () => {
        expect(classifyAgainstExisting("Ujjain", undefined)).toEqual({
            outcome: "valid",
            duplicateLeadId: null,
        });
    });

    it("returns `duplicate_skip` for an open lead in the same city", () => {
        expect(classifyAgainstExisting("Ujjain", lead())).toEqual({
            outcome: "duplicate_skip",
            duplicateLeadId: "DL-1",
        });
    });

    it("is case- and whitespace-insensitive on city", () => {
        expect(
            classifyAgainstExisting("  ujjain ", lead({ city: "Ujjain" })).outcome,
        ).toBe("duplicate_skip");
    });

    it("returns `address_mismatch` when the city genuinely differs", () => {
        expect(classifyAgainstExisting("Indore", lead({ city: "Ujjain" }))).toEqual({
            outcome: "address_mismatch",
            duplicateLeadId: "DL-1",
        });
    });

    it("returns `reactivate` for a Lost lead", () => {
        expect(
            classifyAgainstExisting("Ujjain", lead({ lead_status: "Lost" })),
        ).toEqual({ outcome: "reactivate", duplicateLeadId: "DL-1" });
    });

    // A dealer who moved AND was previously lost is still a reactivation — the
    // new address rides along on the revive rather than blocking it behind a
    // merge request.
    it("prefers `reactivate` over `address_mismatch` when both apply", () => {
        expect(
            classifyAgainstExisting(
                "Indore",
                lead({ lead_status: "Lost", city: "Ujjain" }),
            ).outcome,
        ).toBe("reactivate");
    });

    // An incoming lead with no city cannot contradict an existing one, so it
    // must not raise a merge request a human has no information to resolve.
    it("degrades to `duplicate_skip` when either city is missing", () => {
        expect(classifyAgainstExisting("", lead({ city: "Ujjain" })).outcome).toBe(
            "duplicate_skip",
        );
        expect(classifyAgainstExisting("Indore", lead({ city: null })).outcome).toBe(
            "duplicate_skip",
        );
        expect(classifyAgainstExisting("   ", lead({ city: "Ujjain" })).outcome).toBe(
            "duplicate_skip",
        );
    });

    it("treats any non-Lost status as an open lead", () => {
        for (const status of [
            "New_Unassigned",
            "Assigned_Not_Contacted",
            "Under_Discussion",
            "Converted",
        ]) {
            expect(
                classifyAgainstExisting("Ujjain", lead({ lead_status: status })).outcome,
            ).toBe("duplicate_skip");
        }
    });
});
