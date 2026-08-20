import { describe, expect, test } from "vitest";
import { filterLeads } from "../filter";

// Every record below is lifted verbatim from scraper_raw for run
// SCRAPE-20260820-e3ae054b — "3w battery dealer in kaushambi pyaragraj
// ghoomaniya". That run saved 21 non-Indian dealers and promoted 14 of them
// into the AI dialer queue, because filterLeads had no country gate: the only
// geographic check was isValidIndianMobile, and normalizeIndianPhone had
// already stamped "+91" onto the US numbers, so they passed as Indian mobiles.
//
// The leads here are in POST-normalizeLeads shape (that is the order
// processLeads runs them in): phone already E.164-or-null, `components`
// forwarded from Google Places and absent for Apify rows.

const indianLead = {
  name: "Calcutta Battery Service",
  phone: "+919936078187",
  address: "road, Bharwari, mehat, Uttar Pradesh 212201, India",
  website: null,
  components: { city: "Bharwari", state: "Uttar Pradesh", country: "IN" },
};

describe("filterLeads country gate", () => {
  test("keeps an Indian dealer", () => {
    expect(filterLeads([indianLead])).toHaveLength(1);
  });

  test("drops the Bohemia NY dealer that leaked into SCRAPE-20260820-e3ae054b", () => {
    // Apify returned this for "lead-acid battery dealer for 3-wheelers in
    // Bharwari". US toll-free (888) 643-6884 became +918886436884.
    const leaked = {
      name: "Aloy Hybrid Battery",
      phone: "+918886436884",
      address: "140 Keyland Ct, Bohemia, NY 11716",
      website: "https://aloyhybrid.com/hybrid-battery-replacement-in-bohemia-ny/",
      components: undefined,
    };

    expect(filterLeads([leaked])).toEqual([]);
  });

  test("drops a lead whose Google components report a non-Indian country", () => {
    const bahrain = {
      name: "BAHRAIN CAR BATTERY SERVICE",
      phone: null,
      address: "5GPM+H64, Road No. 411, Salmabad, Bahrain",
      website: null,
      components: { city: "Salmabad", country: "BH" },
    };

    expect(filterLeads([bahrain])).toEqual([]);
  });

  test.each([
    ["F7CG+PGF, Biratnagar 56613, Nepal"],
    ["Bazar, Bhully Thana 5100, Bangladesh"],
    [
      "Junction of Myoma Road and Myaing Road Quarter (8), Wartan Area, Pakokku 04201, Myanmar (Burma)",
    ],
    ["190 6 Tambon Mae Hia, Chang Wat Chiang Mai 50100, Thailand"],
    ["90 St - Al Naba'a - Sharjah - United Arab Emirates"],
    ["3381 SW 11th Ave, Fort Lauderdale, FL 33315"],
  ])("drops a lead addressed in %s", (address) => {
    const foreign = {
      name: "Battery Dealer",
      phone: null,
      address,
      website: null,
      components: undefined,
    };

    expect(filterLeads([foreign])).toEqual([]);
  });

  test("keeps an Indian lead when Google omitted address components", () => {
    const noComponents = {
      name: "Kaushambi E Bike & Rickshaw Agency",
      phone: "+918506970949",
      address:
        "HF5J+4RQ, near Union Bank, Naya Bazar, Bharwari, Uttar Pradesh 212201, India",
      website: null,
      components: undefined,
    };

    expect(filterLeads([noComponents])).toHaveLength(1);
  });

  test("keeps an Indian address that names no country at all", () => {
    // Google frequently omits the ", India" suffix on Plus-Code addresses.
    // The gate must reject on positive evidence of a foreign country only —
    // never on the absence of the word "India" — or real leads disappear.
    const unlabelled = {
      name: "Moti Battery & Electronics",
      phone: "+919936047255",
      address: "Ward 15, Manjhanpur Bharwari Rd, Sindhiya Amad, Karari",
      website: null,
      components: undefined,
    };

    expect(filterLeads([unlabelled])).toHaveLength(1);
  });
});

describe("filterLeads existing rules still apply", () => {
  test("drops a lead with no name", () => {
    expect(filterLeads([{ ...indianLead, name: null }])).toEqual([]);
  });

  test("drops a lead with a junk name", () => {
    expect(filterLeads([{ ...indianLead, name: "test battery" }])).toEqual([]);
  });

  test("drops an Indian lead with a landline-shaped phone", () => {
    expect(filterLeads([{ ...indianLead, phone: "+911145678901" }])).toEqual([]);
  });
});
