import { describe, expect, test } from "vitest";
import { buildApifyActorInput } from "../apify";
import { buildSearchTextBody } from "../googlePlaces";

// Neither source was ever told to stay in India. Apify's actor got a bare
// searchStringsArray and, driven from a US-hosted crawler with no anchor for
// "Sirathu", returned twelve Fort Lauderdale battery shops on run
// SCRAPE-20260820-e3ae054b. These two assertions are the tripwire: the country
// scope is part of the request contract, not an incidental field.

describe("search requests are scoped to India", () => {
  test("apify actor input pins the crawl to India", () => {
    const input = buildApifyActorInput(
      "lead-acid battery dealer for 3-wheelers in Sirathu",
      20,
    );

    expect(input.countryCode).toBe("in");
  });

  test("apify actor input still carries the query and cap", () => {
    const input = buildApifyActorInput("e-rickshaw battery dealer in Karari", 5);

    expect(input.searchStringsArray).toEqual([
      "e-rickshaw battery dealer in Karari",
    ]);
    expect(input.maxCrawledPlacesPerSearch).toBe(5);
  });

  test("google places body pins the search region to India", () => {
    const body = buildSearchTextBody("EV battery supplier in Jasra");

    expect(body.regionCode).toBe("IN");
  });

  test("google places body still carries the query, cap and page token", () => {
    const body = buildSearchTextBody("EV battery supplier in Jasra", "tok-123");

    expect(body.textQuery).toBe("EV battery supplier in Jasra");
    expect(body.maxResultCount).toBe(20);
    expect(body.pageToken).toBe("tok-123");
  });

  test("google places body omits pageToken on the first page", () => {
    expect(buildSearchTextBody("EV battery supplier in Jasra")).not.toHaveProperty(
      "pageToken",
    );
  });
});
