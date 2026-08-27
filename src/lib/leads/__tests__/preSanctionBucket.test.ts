import { describe, expect, it } from "vitest";

import {
  PRE_SANCTION_MAX,
  coerceBucketItems,
  mergeBucketItems,
} from "../pre-sanction-bucket-rules";

const item = (n: number) => ({
  url: `/api/files/documents/leads/L/extra/${n}.pdf`,
  name: `${n}.pdf`,
  type: "application/pdf",
  size: n,
});

describe("mergeBucketItems", () => {
  it("appends new items and reports nothing dropped", () => {
    const r = mergeBucketItems([item(1)], [item(2), item(3)]);
    expect(r.items.map((i) => i.name)).toEqual(["1.pdf", "2.pdf", "3.pdf"]);
    expect(r.dropped).toBe(0);
  });

  it("dedupes by url — a resent file does not consume a slot", () => {
    const r = mergeBucketItems([item(1)], [item(1), { ...item(1), name: "renamed.pdf" }]);
    expect(r.items).toHaveLength(1);
    expect(r.dropped).toBe(0);
  });

  it("caps at the Section-G limit and counts the overflow", () => {
    const existing = Array.from({ length: PRE_SANCTION_MAX - 1 }, (_, i) => item(i));
    const r = mergeBucketItems(existing, [item(100), item(101), item(102)]);
    expect(r.items).toHaveLength(PRE_SANCTION_MAX);
    expect(r.items[PRE_SANCTION_MAX - 1].name).toBe("100.pdf");
    expect(r.dropped).toBe(2);
  });

  it("never grows an already-oversized bucket", () => {
    const existing = Array.from({ length: PRE_SANCTION_MAX + 2 }, (_, i) => item(i));
    const r = mergeBucketItems(existing, [item(200)]);
    expect(r.items).toHaveLength(PRE_SANCTION_MAX);
    expect(r.dropped).toBe(1);
  });
});

describe("coerceBucketItems", () => {
  it("drops malformed entries and fills defaults, matching the PATCH route", () => {
    expect(
      coerceBucketItems([
        { url: "/a", name: "a" },
        { name: "no-url" },
        null,
        "string",
        { url: "/b", size: "7" },
      ]),
    ).toEqual([
      { url: "/a", name: "a", type: "application/octet-stream", size: 0 },
      { url: "/b", name: "file", type: "application/octet-stream", size: 7 },
    ]);
    expect(coerceBucketItems(null)).toEqual([]);
  });
});
