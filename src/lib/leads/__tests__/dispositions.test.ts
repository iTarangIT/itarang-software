// Unit tests for the CC team's disposition taxonomy (E-236).
//
// What these pin down is not "the sheet was typed in correctly" — a diff would
// show that. It is the three behaviours the rest of the system depends on and
// that are easy to break without noticing:
//
//   * an unrecognised disposition is KEPT, never dropped and never guessed a
//     bucket for. It is the only signal that NeoDove's vocabulary has moved.
//   * "Commercials Explained" is in two buckets, and which one it resolves to
//     is decided deterministically rather than by map iteration order.
//   * a not-connected reason has no bucket. The filter UI hides the bucket
//     select on that basis, so a bucket appearing here would make an
//     unreachable filter combination reachable.

import { describe, expect, it } from "vitest";
import {
    ALL_CONNECTED_DISPOSITIONS,
    CONNECTED_DISPOSITIONS,
    DISPOSITION_BUCKETS,
    NOT_CONNECTED_REASONS,
    canonicalDisposition,
    classifyDisposition,
    isConnectStatus,
    isDispositionBucket,
    isKnownDisposition,
    normalizeDispositionKey,
} from "../dispositions";

describe("the sheet itself", () => {
    it("classifies every connected disposition into the bucket it is listed under", () => {
        for (const bucket of DISPOSITION_BUCKETS) {
            for (const label of CONNECTED_DISPOSITIONS[bucket]) {
                const hit = classifyDisposition(label);
                expect(hit?.isKnown, label).toBe(true);
                expect(hit?.connectStatus, label).toBe("connected");
                // "Commercials Explained" is in two buckets; assert membership
                // rather than a single bucket for it specifically.
                const buckets = DISPOSITION_BUCKETS.filter((b) =>
                    CONNECTED_DISPOSITIONS[b].includes(label),
                );
                expect(buckets, label).toContain(hit?.bucket);
            }
        }
    });

    it("gives every not-connected reason a null bucket", () => {
        for (const label of NOT_CONNECTED_REASONS) {
            const hit = classifyDisposition(label);
            expect(hit?.isKnown, label).toBe(true);
            expect(hit?.connectStatus, label).toBe("not_connected");
            // Load-bearing: the filter hides the bucket select for these, so a
            // bucket here would make "Not Connected + Hot" selectable.
            expect(hit?.bucket, label).toBeNull();
        }
    });

    it("de-duplicates the connected list without losing anything", () => {
        const flat = DISPOSITION_BUCKETS.flatMap((b) => CONNECTED_DISPOSITIONS[b]);
        expect(new Set(ALL_CONNECTED_DISPOSITIONS)).toEqual(new Set(flat));
        expect(ALL_CONNECTED_DISPOSITIONS.length).toBe(new Set(flat).size);
    });

    it("has exactly one label in two buckets — the known ambiguity", () => {
        const seen = new Map<string, number>();
        for (const bucket of DISPOSITION_BUCKETS) {
            for (const label of CONNECTED_DISPOSITIONS[bucket]) {
                seen.set(label, (seen.get(label) ?? 0) + 1);
            }
        }
        const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([l]) => l);
        // If this fails, the sheet gained a second ambiguity and resolveBucket's
        // documented "first occurrence wins" default now silently applies to it.
        expect(duplicated).toEqual(["Commercials Explained"]);
    });
});

describe("the Warm/Hot ambiguity", () => {
    it("defaults to Warm — the sheet's first occurrence", () => {
        expect(classifyDisposition("Commercials Explained")?.bucket).toBe("Warm");
    });

    it("resolves to Hot when NeoDove's stage says so", () => {
        expect(
            classifyDisposition("Commercials Explained", { stage: "Hot" })?.bucket,
        ).toBe("Hot");
        expect(
            classifyDisposition("Commercials Explained", { stage: "negotiation" })
                ?.bucket,
        ).toBe("Hot");
    });

    it("ignores a stage hint that is not one of the two candidates", () => {
        // "Lost" is a real bucket but not one this label lives in. Honouring it
        // would file a Commercials Explained call under Lost.
        expect(
            classifyDisposition("Commercials Explained", { stage: "Lost" })?.bucket,
        ).toBe("Warm");
        expect(
            classifyDisposition("Commercials Explained", { stage: "IN-PROGRESS" })
                ?.bucket,
        ).toBe("Warm");
    });

    it("does not let a stage hint move an unambiguous label", () => {
        expect(classifyDisposition("Price High", { stage: "Hot" })?.bucket).toBe("Warm");
        expect(classifyDisposition("Deal Closed", { stage: "Cold" })?.bucket).toBe(
            "Converted",
        );
    });
});

describe("normalisation", () => {
    it("ignores case, padding and doubled spaces", () => {
        for (const variant of [
            "  price high  ",
            "PRICE HIGH",
            "Price   High",
            "pRiCe HiGh",
        ]) {
            expect(classifyDisposition(variant)?.label, variant).toBe("Price High");
        }
    });

    it("normalises the spacing around a slash", () => {
        for (const variant of [
            "Incorrect/Invalid number",
            "Incorrect /Invalid number",
            "Incorrect  /  Invalid number",
        ]) {
            expect(classifyDisposition(variant)?.label, variant).toBe(
                "Incorrect / Invalid number",
            );
        }
    });

    it("accepts the corrected spelling of the sheet's typo, and the typo", () => {
        // The sheet says "Documents Recieved". If someone fixes it in NeoDove's
        // settings, historical rows must not silently become unmapped.
        expect(classifyDisposition("Documents Received")?.label).toBe(
            "Documents Recieved",
        );
        expect(classifyDisposition("Documents Recieved")?.isKnown).toBe(true);
        expect(classifyDisposition("Commercials Finalized")?.label).toBe(
            "Commercials Finalised",
        );
    });

    it("maps the stock-vocabulary synonyms onto sheet values", () => {
        expect(classifyDisposition("wrong number")?.label).toBe(
            "Incorrect / Invalid number",
        );
        expect(classifyDisposition("Switched off")?.label).toBe("Switch off");
        expect(classifyDisposition("No answer")?.label).toBe("Did not pick");
    });

    it("normalizeDispositionKey is stable for equivalent strings", () => {
        expect(normalizeDispositionKey(" Not   Interested ")).toBe(
            normalizeDispositionKey("not interested"),
        );
    });
});

describe("values outside the sheet", () => {
    it("keeps the raw text and refuses to invent a bucket", () => {
        const hit = classifyDisposition("Sent to field team");
        expect(hit).not.toBeNull();
        expect(hit?.isKnown).toBe(false);
        expect(hit?.label).toBe("Sent to field team");
        expect(hit?.bucket).toBeNull();
    });

    it("still records whether the call connected, when the payload said", () => {
        expect(
            classifyDisposition("Sent to field team", { callConnected: true })
                ?.connectStatus,
        ).toBe("connected");
        expect(
            classifyDisposition("Sent to field team", { callConnected: false })
                ?.connectStatus,
        ).toBe("not_connected");
        // "We were not told" is distinct from "it did not connect".
        expect(classifyDisposition("Sent to field team")?.connectStatus).toBeNull();
    });

    it("does not let a stage hint assign a bucket to an unknown label", () => {
        // A stage is coarser than the sheet and is only ever a tie-breaker.
        // Trusting it here would file arbitrary vendor text under Converted.
        expect(
            classifyDisposition("Whatever", { stage: "Converted" })?.bucket,
        ).toBeNull();
    });

    it("returns null only for an empty input", () => {
        expect(classifyDisposition(null)).toBeNull();
        expect(classifyDisposition(undefined)).toBeNull();
        expect(classifyDisposition("   ")).toBeNull();
    });
});

describe("query-string guards", () => {
    it("accepts only the two connect statuses", () => {
        expect(isConnectStatus("connected")).toBe(true);
        expect(isConnectStatus("not_connected")).toBe(true);
        expect(isConnectStatus("Connected")).toBe(false);
        expect(isConnectStatus("bogus")).toBe(false);
        expect(isConnectStatus(null)).toBe(false);
    });

    it("accepts only the five buckets, case-sensitively", () => {
        for (const b of DISPOSITION_BUCKETS) expect(isDispositionBucket(b)).toBe(true);
        // The column stores the canonical casing, so a lowercase param would
        // match nothing — rejecting it is what stops a silent empty result.
        expect(isDispositionBucket("hot")).toBe(false);
        expect(isDispositionBucket("")).toBe(false);
        expect(isDispositionBucket(null)).toBe(false);
    });

    it("recognises sheet dispositions and rejects everything else", () => {
        expect(isKnownDisposition("REJECTED BY US")).toBe(true);
        expect(isKnownDisposition("rejected by us")).toBe(true);
        expect(isKnownDisposition("Did not pick")).toBe(true);
        expect(isKnownDisposition("Sent to field team")).toBe(false);
        expect(isKnownDisposition(null)).toBe(false);
    });

    it("canonicalises a known label and passes an unknown one through", () => {
        expect(canonicalDisposition("price high")).toBe("Price High");
        expect(canonicalDisposition("Sent to field team")).toBe("Sent to field team");
    });
});
