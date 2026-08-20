import { describe, expect, test } from "vitest";
import { normalizeLeads } from "../normalize";

// normalizeIndianPhone prefixes "+91" to any 10-digit string, so the US
// numbers Apify returned for SCRAPE-20260820-e3ae054b were rewritten into
// plausible Indian mobiles — (954) 527-4640 became +919545274640 — and then
// promoted into dealer_leads as callable numbers. A phone must never acquire
// an Indian country code when the address it came with is not Indian.

describe("normalizeLeads phone handling", () => {
  test("normalizes an Indian phone to E.164", () => {
    const [lead] = normalizeLeads(
      [
        {
          name: "Calcutta Battery Service",
          phone: "099360 78187",
          address: "road, Bharwari, mehat, Uttar Pradesh 212201, India",
          components: { city: "Bharwari", state: "Uttar Pradesh", country: "IN" },
        },
      ],
      "google_places",
    );

    expect(lead.phone).toBe("+919936078187");
  });

  test("does not stamp +91 onto a US number", () => {
    const [lead] = normalizeLeads(
      [
        {
          name: "Aloy Hybrid Battery",
          phone: "(888) 643-6884",
          address: "140 Keyland Ct, Bohemia, NY 11716",
        },
      ],
      "apify",
    );

    expect(lead.phone).toBeNull();
  });

  test("does not stamp +91 onto a number from a country Google identified", () => {
    const [lead] = normalizeLeads(
      [
        {
          name: "SK RICKSHAW & TERAI MOTORS BATTERY",
          phone: "982-5786855",
          address: "F7CG+PGF, Biratnagar 56613, Nepal",
          components: { city: "Biratnagar", country: "NP" },
        },
      ],
      "google_places",
    );

    expect(lead.phone).toBeNull();
  });
});
