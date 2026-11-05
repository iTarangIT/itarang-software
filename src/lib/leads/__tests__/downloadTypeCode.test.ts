import { describe, expect, it } from "vitest";
import { typeCodeForDownload } from "../downloadTypeCode";

describe("ID 209: Type (code) in downloads", () => {
    it("shows a person's call as 'call'", () => {
        expect(typeCodeForDownload("inside_sales_call")).toBe("call");
    });

    it("keeps AI calls and every other code as stored", () => {
        expect(typeCodeForDownload("ai_call")).toBe("ai_call");
        expect(typeCodeForDownload("quote_dispatched")).toBe("quote_dispatched");
    });

    it("returns null for an empty code so callers print a dash", () => {
        expect(typeCodeForDownload(null)).toBeNull();
        expect(typeCodeForDownload("")).toBeNull();
    });
});
