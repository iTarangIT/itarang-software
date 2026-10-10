import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LEAD_EVENT_TYPES, eventTypeLabels, eventTypeMatchers, parseEventTypes } from "../eventTypes";

describe("parseEventTypes (ID 34)", () => {
    it("nothing chosen means every type", () => {
        expect(parseEventTypes(null)).toBeUndefined();
        expect(parseEventTypes("")).toBeUndefined();
        expect(parseEventTypes(" , ")).toBeUndefined();
    });

    it("keeps known values only, in catalogue order", () => {
        expect(parseEventTypes("visit, call ,bogus")).toEqual(["call", "visit"]);
    });

    it("only unknown values means every type, not none", () => {
        expect(parseEventTypes("bogus,also_bogus")).toBeUndefined();
    });

    it("every type ticked is the same as no filter", () => {
        expect(parseEventTypes(LEAD_EVENT_TYPES.map((t) => t.value).join(","))).toBeUndefined();
    });
});

describe("eventTypeMatchers", () => {
    it("exact labels, and a prefix for the commercials family", () => {
        expect(eventTypeMatchers(["call_ai", "commercials", "lead_created"])).toEqual({
            exact: ["Call (AI)", "Lead created"],
            prefixes: ["Commercials: "],
        });
    });

    it("labels for the file", () => {
        expect(eventTypeLabels(["re_inquiry", "sales_ready"])).toBe("Re-inquiry, Sales-ready");
    });
});

describe("the SQL writes exactly these labels (eventLog.ts)", () => {
    const src = readFileSync(join(__dirname, "..", "eventLog.ts"), "utf8");

    it.each(LEAD_EVENT_TYPES.map((t) => [t.value, t] as const))("%s", (value, t) => {
        if ("prefix" in t && t.prefix) expect(src).toContain(`'${t.prefix}'`);
        else expect(src).toContain(`'${t.label}'`);
        // …and some source is tagged with the value, so the filter can reach it.
        expect(src).toMatch(new RegExp(`types: \\[[^\\]]*"${value}"`));
    });
});
