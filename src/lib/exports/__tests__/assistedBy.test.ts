// ID 183 — the "Assisted by (iTarang)" cell on loan files, the KYC export and
// the KYC review digest.

import { describe, expect, it } from "vitest";

import { assistedByLabel, parseAssistedBy, withAssistedBy } from "@/lib/exports/assistedBy";

describe("assistedByLabel", () => {
    it("lists distinct names A–Z with the step count", () => {
        expect(assistedByLabel({ names: ["Vikram S", "Asha Rao", "Asha Rao"], steps: 3 })).toBe("Asha Rao, Vikram S (3 steps)");
        expect(assistedByLabel({ names: ["Asha Rao"], steps: 1 })).toBe("Asha Rao (1 step)");
    });

    it("reads the JSON text a driver may hand back", () => {
        expect(assistedByLabel('{"names":["Asha Rao"],"steps":2}')).toBe("Asha Rao (2 steps)");
    });

    it("is blank when nobody from iTarang acted for the dealer", () => {
        expect(assistedByLabel(null)).toBeNull();
        expect(assistedByLabel({ names: [], steps: 0 })).toBeNull();
        expect(assistedByLabel("not json")).toBeNull();
    });

    it("digest rows: appended after the dealer, dealer untouched when nobody helped", () => {
        expect(withAssistedBy("Shakti Motors", { names: ["Asha Rao"], steps: 2 })).toBe("Shakti Motors · Assisted by Asha Rao (2 steps)");
        expect(withAssistedBy(null, { names: ["Asha Rao"], steps: 1 })).toBe("Assisted by Asha Rao (1 step)");
        expect(withAssistedBy("Shakti Motors", null)).toBe("Shakti Motors");
        expect(withAssistedBy("", null)).toBeNull();
    });

    it("falls back to the number of people when the step count is missing", () => {
        expect(parseAssistedBy({ names: ["B", " A "] })).toEqual({ names: ["A", "B"], steps: 2 });
    });
});
