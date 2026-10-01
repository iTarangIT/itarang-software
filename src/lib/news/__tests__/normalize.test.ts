import { describe, expect, it } from "vitest";

import {
  canonicalUrl,
  clip,
  normalizeTitle,
  splitGoogleTitle,
  stripHtml,
  titleHash,
  urlHash,
} from "../normalize";

describe("canonicalUrl", () => {
  it("strips tracking params, fragments and trailing slash, lowercases host", () => {
    expect(
      canonicalUrl("https://WWW.Example.com/a/b/?utm_source=x&id=7&fbclid=zz#top"),
    ).toBe("https://www.example.com/a/b?id=7");
  });
  it("keeps a bare origin stable", () => {
    expect(canonicalUrl("https://example.com/")).toBe("https://example.com");
  });
  it("returns garbage unchanged rather than throwing", () => {
    expect(canonicalUrl("not a url")).toBe("not a url");
  });
  it("two utm variants hash the same", () => {
    expect(urlHash("https://a.com/x?utm_medium=rss")).toBe(urlHash("https://a.com/x/"));
  });
});

describe("normalizeTitle / titleHash", () => {
  it("ignores case, punctuation and stopwords", () => {
    expect(normalizeTitle("The Govt. Of India Approves ₹10,000-Crore Solar Plan!")).toBe(
      "govt india approves 10 000 crore solar plan",
    );
  });
  it("same story, different punctuation → same hash", () => {
    expect(titleHash("Tata Power wins 500 MW solar bid")).toBe(titleHash("Tata Power Wins 500-MW Solar Bid"));
  });
  it("caps at 12 meaningful words so a long sub-headline does not break the match", () => {
    const a = "one two three four five six seven eight nine ten eleven twelve thirteen";
    const b = "one two three four five six seven eight nine ten eleven twelve fourteen";
    expect(titleHash(a)).toBe(titleHash(b));
  });
});

describe("stripHtml", () => {
  it("removes tags and decodes entities", () => {
    expect(stripHtml("<p>Solar &amp; wind <b>grow</b>&nbsp;fast&#8230;</p>")).toBe("Solar & wind grow fast…");
  });
  it("handles null", () => {
    expect(stripHtml(null)).toBe("");
  });
});

describe("splitGoogleTitle", () => {
  it("splits 'Headline - Publisher'", () => {
    expect(splitGoogleTitle("India adds 5 GW solar in Q2 - Mercom India")).toEqual({
      title: "India adds 5 GW solar in Q2",
      publisher: "Mercom India",
    });
  });
  it("leaves a headline without a publisher suffix alone", () => {
    expect(splitGoogleTitle("Battery prices fall again").publisher).toBeNull();
  });
});

describe("clip", () => {
  it("cuts on a word boundary and adds an ellipsis", () => {
    expect(clip("alpha beta gamma delta", 12)).toBe("alpha beta…");
    expect(clip("short", 12)).toBe("short");
  });
});
