// E-398 + search filters: strict / broad query building, the strict post-filter,
// the Approached → Accepted → Replied → Meeting funnel, and the CSV writer.
import { describe, expect, it } from "vitest";

import { parseDraft } from "../agent/reply-draft";
import { isCategory, LI_CATEGORIES } from "../categories";
import { toCsv } from "../lib/csv";
import { discoveryQuery, geoTarget, splitList } from "../providers/search/discovery";
import { pctOf, rollUp, type CampaignFunnel } from "../services/funnel";
import { kpis } from "../services/kpis";
import { matchesFilters } from "../services/searchFilter";

describe("discoveryQuery filters", () => {
  const base = { keywords: "EV dealer" };

  it("broad: plain terms, company stays quoted, country appended", () => {
    expect(discoveryQuery({ ...base, title: "Owner", company: "Zippee", city: "Pune", state: "Maharashtra", country: "India" })).toBe(
      'site:linkedin.com/in EV dealer Owner "Zippee" Pune Maharashtra India',
    );
  });

  it("strict: title / city / state become exact phrases", () => {
    expect(discoveryQuery({ ...base, title: "Fleet Manager", city: "Navi Mumbai", state: "Maharashtra", match: "strict" })).toBe(
      'site:linkedin.com/in EV dealer "Fleet Manager" "Navi Mumbai" "Maharashtra"',
    );
  });

  it("exclude words become -terms; multi-word ones quoted", () => {
    expect(discoveryQuery({ ...base, exclude: "student, intern , used cars" })).toBe(
      'site:linkedin.com/in EV dealer -student -intern -"used cars"',
    );
  });

  it("legacy location still works and quotes inside values are dropped", () => {
    expect(discoveryQuery({ ...base, location: "Pune", company: 'Ola "Electric"' })).toBe('site:linkedin.com/in EV dealer "Ola Electric" Pune');
  });

  it("splitList trims and drops blanks", () => {
    expect(splitList(" a, ,b ,, ")).toEqual(["a", "b"]);
    expect(splitList(null)).toEqual([]);
  });

  it("geoTarget sends country only, and only for known countries", () => {
    expect(geoTarget({ country: "India" })).toEqual({ location: "India", country: "IN" });
    expect(geoTarget({ country: "Narnia" })).toEqual({});
    expect(geoTarget({ country: null })).toEqual({});
  });
});

describe("matchesFilters (strict post-filter)", () => {
  const rec = {
    fullName: "Asha Rao",
    headline: "Owner",
    company: "Rao EV Motors",
    city: null,
    raw: { source: "web_search", title: "Asha Rao - Owner - Rao EV Motors | LinkedIn", description: "Location: Pune · 500+ connections" },
  };

  it("broad keeps everything except exclude-word hits", () => {
    expect(matchesFilters(rec, { match: "broad", city: "Delhi" }).ok).toBe(true);
    expect(matchesFilters(rec, { match: "broad", exclude: "motors" }).ok).toBe(false);
  });

  it("strict requires each filled field somewhere in the profile text (case-insensitive)", () => {
    expect(matchesFilters(rec, { match: "strict", city: "pune", title: "OWNER", company: "rao ev" }).ok).toBe(true);
    const r = matchesFilters(rec, { match: "strict", city: "Delhi" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("city");
  });

  it("strict reads enriched Bright Data fields (location, experience)", () => {
    const enriched = {
      ...rec,
      city: null,
      raw: { location: "Pune, Maharashtra, India", experience: [{ title: "Founder", company: "Rao EV Motors" }] },
    };
    expect(matchesFilters(enriched, { match: "strict", state: "Maharashtra", title: "founder" }).ok).toBe(true);
  });

  it("legacy location counts as city", () => {
    expect(matchesFilters(rec, { match: "strict", location: "Mumbai" }).ok).toBe(false);
  });
});

describe("funnel KPIs", () => {
  const d = new Date();
  it("approached = invited or direct-messaged; meetings counted from the marked rows", () => {
    const k = kpis(
      [
        { invite_sent_at: d, accepted_at: d, message_sent_at: d, replied_at: d, meeting: true },
        { invite_sent_at: d, accepted_at: null, message_sent_at: null, replied_at: null },
        { invite_sent_at: null, accepted_at: null, message_sent_at: d, replied_at: d }, // existing connection
        { invite_sent_at: null, accepted_at: null, message_sent_at: null, replied_at: null }, // queued, not approached
      ],
      1,
    );
    expect(k).toMatchObject({ approached: 3, invited: 2, accepted: 1, replied: 2, meetings: 1, acceptance_pct: 50, meeting_pct: 33.3 });
  });

  it("rollUp groups by category, sorts by approached, totals everything", () => {
    const c = (category: string, approached: number, meetings = 0): CampaignFunnel => ({
      campaign_id: `${category}-${approached}`,
      name: category,
      status: "running",
      category,
      account_id: "a",
      created_at: "",
      selected: approached,
      approached,
      invited: approached,
      accepted: 0,
      replied: 0,
      meetings,
      positive: 0,
    });
    const { categories, total } = rollUp([c("FinTech", 5, 1), c("3 Wheeler", 10), c("FinTech", 7, 2)]);
    expect(categories.map((x) => [x.category, x.campaigns, x.approached, x.meetings])).toEqual([
      ["FinTech", 2, 12, 3],
      ["3 Wheeler", 1, 10, 0],
    ]);
    expect(total).toMatchObject({ campaigns: 3, approached: 22, meetings: 3 });
    expect(pctOf(3, 22)).toBe(13.6);
    expect(pctOf(1, 0)).toBeNull();
  });
});

describe("meeting hint from the reply-draft model", () => {
  it("only an explicit true raises the hint", () => {
    expect(parseDraft({ draft: "Great, talk tomorrow at 11", sentiment: "positive", meeting: true })?.meeting).toBe(true);
    expect(parseDraft({ draft: "Sure", meeting: "yes" })?.meeting).toBe(false);
    expect(parseDraft({ draft: "Sure" })?.meeting).toBe(false);
  });
});

describe("categories", () => {
  it("fixed list incl. the asked-for ones", () => {
    expect(LI_CATEGORIES).toEqual(expect.arrayContaining(["3 Wheeler", "2 Wheeler", "FinTech", "Other"]));
    expect(isCategory("3W")).toBe(false);
  });
});

describe("toCsv", () => {
  it("quotes, escapes and neutralises formulas; BOM first", () => {
    const csv = toCsv({
      name: "t",
      columns: [
        { key: "a", header: "Name" },
        { key: "b", header: "Note" },
      ],
      rows: [{ a: 'Rao, "Asha"', b: "=HYPERLINK(1)" }, { a: null, b: 3 }],
    });
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split("\r\n")).toEqual(["Name,Note", '"Rao, ""Asha""",\'=HYPERLINK(1)', ",3"]);
  });
});
