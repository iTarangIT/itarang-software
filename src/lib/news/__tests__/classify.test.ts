import { describe, expect, it } from "vitest";

import { buildBriefPrompt, parseBriefResponse } from "../brief-core";
import { buildClassifyPrompt, parseClassifyResponse } from "../classify-core";
import { safeParseJson } from "../gemini";
import { normalizeGreenNewsSettings } from "../settings-core";
import { DEFAULT_SOURCES, resolveSources } from "../sources";
import { istDateString, istHour } from "../time";

describe("safeParseJson", () => {
  it("accepts plain JSON", () => {
    expect(safeParseJson('{"a":1}')).toEqual({ a: 1 });
  });
  it("strips a ```json fence", () => {
    expect(safeParseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it("recovers the outer object from chatter", () => {
    expect(safeParseJson('Sure! {"a":1} hope that helps')).toEqual({ a: 1 });
  });
  it("returns null on garbage", () => {
    expect(safeParseJson("nope")).toBeNull();
  });
});

describe("parseClassifyResponse", () => {
  const ids = ["a", "b", "c"];
  it("maps valid rows, clamps relevance, defaults bad enums", () => {
    const out = parseClassifyResponse(
      {
        items: [
          { id: "a", region: "india", category: "ev_battery", relevance: 120, summary: "  ok  " },
          { id: "b", region: "mars", category: "nope", relevance: "35", summary: 7 },
          { id: "zzz", region: "india", category: "other", relevance: 50, summary: "x" },
          { id: "a", region: "world", category: "other", relevance: 1, summary: "dupe" },
        ],
      },
      ids,
      new Map([["b", "india"]]),
    );
    expect(out.size).toBe(2);
    expect(out.get("a")).toEqual({ region: "india", category: "ev_battery", relevance: 100, summary: "ok" });
    expect(out.get("b")).toEqual({ region: "india", category: "other", relevance: 35, summary: "" });
  });
  it("returns an empty map for a null / malformed body", () => {
    expect(parseClassifyResponse(null, ids).size).toBe(0);
    expect(parseClassifyResponse({ items: "x" }, ids).size).toBe(0);
  });
});

describe("buildClassifyPrompt", () => {
  it("includes every id and the category keys", () => {
    const p = buildClassifyPrompt([
      { id: "id-1", title: "T", snippet: "S", sourceName: "Src", regionHint: "india" },
    ]);
    expect(p).toContain('"id-1"');
    expect(p).toContain('"policy_subsidy"');
    expect(p).toContain('"business_model"');
  });
});

describe("parseBriefResponse", () => {
  it("keeps at most 5 bullets and only known ids", () => {
    const out = parseBriefResponse(
      {
        bullets: [
          { text: "one", item_ids: ["a", "nope"] },
          { text: "", item_ids: ["a"] },
          { text: "two" },
          { text: "three", item_ids: "a" },
          { text: "four", item_ids: [] },
          { text: "five", item_ids: [] },
          { text: "six", item_ids: [] },
        ],
      },
      ["a", "b"],
    );
    expect(out.map((b) => b.text)).toEqual(["one", "two", "three", "four", "five"]);
    expect(out[0].item_ids).toEqual(["a"]);
    expect(out[2].item_ids).toEqual([]);
  });
  it("mentions the date and every item id in the prompt", () => {
    const p = buildBriefPrompt(
      [{ id: "i1", title: "t", summary: "s", region: "india", category: "ev_battery", sourceName: "x" }],
      "2026-09-24",
    );
    expect(p).toContain("2026-09-24");
    expect(p).toContain('"i1"');
    expect(p).toContain("EV & batteries");
  });
});

describe("settings", () => {
  it("fills defaults and drops junk", () => {
    expect(normalizeGreenNewsSettings(null)).toEqual({ enabled: true, extraFeeds: [], extraQueries: [], minRelevance: 40 });
    expect(
      normalizeGreenNewsSettings({ enabled: false, extraFeeds: ["https://a/feed", 3, ""], minRelevance: "250" }),
    ).toEqual({ enabled: false, extraFeeds: ["https://a/feed"], extraQueries: [], minRelevance: 100 });
  });
});

describe("sources", () => {
  it("default keys are unique and ≤ 40 chars", () => {
    const keys = DEFAULT_SOURCES.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k.length <= 40)).toBe(true);
  });
  it("Google News queries carry the India locale and a recency operator", () => {
    const gn = DEFAULT_SOURCES.find((s) => s.kind === "gnews")!;
    expect(gn.url).toContain("hl=en-IN");
    expect(gn.url).toContain("when%3A2d");
  });
  it("merges extra feeds and queries, ignoring bad URLs", () => {
    const out = resolveSources({ extraFeeds: ["https://ex.com/feed", "ftp://bad"], extraQueries: ["battery swap"] });
    expect(out.length).toBe(DEFAULT_SOURCES.length + 2);
    expect(out.at(-2)).toMatchObject({ key: "extra_feed_1", name: "ex.com", kind: "rss" });
    expect(out.at(-1)!.url).toContain("battery%20swap");
  });
});

describe("IST helpers", () => {
  it("rolls the date at IST midnight, not UTC", () => {
    // 2026-09-23 20:00 UTC = 2026-09-24 01:30 IST
    const d = new Date("2026-09-23T20:00:00Z");
    expect(istDateString(d)).toBe("2026-09-24");
    expect(istHour(d)).toBe(1);
  });
});
