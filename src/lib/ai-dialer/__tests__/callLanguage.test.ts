import { describe, expect, it } from "vitest";
import {
    AGENT_LANGUAGES,
    languageToStore,
    openingLanguageOverride,
    storedLanguageName,
    toAgentLanguage,
} from "../callLanguage";

describe("toAgentLanguage", () => {
    it("reads stored names, codes, locales and native spellings", () => {
        expect(toAgentLanguage("hindi")).toBe("hi");
        expect(toAgentLanguage("Hinglish")).toBe("hi");
        expect(toAgentLanguage("Marathi")).toBe("mr");
        expect(toAgentLanguage("kn")).toBe("kn");
        expect(toAgentLanguage("en-IN")).toBe("en");
        expect(toAgentLanguage("ગુજરાતી")).toBe("gu");
        expect(toAgentLanguage("Bangla")).toBe("bn");
        expect(toAgentLanguage("pa_IN")).toBe("pa");
    });

    it("is null for anything it does not know", () => {
        for (const v of [null, undefined, "", "  ", "unknown", "tamil", "fr"]) {
            expect(toAgentLanguage(v), String(v)).toBeNull();
        }
    });

    it("round-trips every agent language through its stored name", () => {
        for (const code of AGENT_LANGUAGES) expect(toAgentLanguage(storedLanguageName(code))).toBe(code);
    });
});

describe("openingLanguageOverride", () => {
    it("only overrides for a known, non-default language", () => {
        expect(openingLanguageOverride("marathi")).toBe("mr");
        expect(openingLanguageOverride("hindi")).toBeNull();
        expect(openingLanguageOverride(null)).toBeNull();
        expect(openingLanguageOverride("tamil")).toBeNull();
    });
});

describe("languageToStore", () => {
    it("stores what a speaking dealer used", () => {
        expect(languageToStore({ callLanguage: "mr", dealerSpoke: true, current: "hindi" })).toBe("marathi");
    });

    it("ignores calls where nobody spoke, unknowns, and no-change", () => {
        expect(languageToStore({ callLanguage: "mr", dealerSpoke: false, current: "hindi" })).toBeNull();
        expect(languageToStore({ callLanguage: "unknown", dealerSpoke: true, current: "hindi" })).toBeNull();
        expect(languageToStore({ callLanguage: "hi", dealerSpoke: true, current: "Hindi" })).toBeNull();
    });
});
