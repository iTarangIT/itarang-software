/**
 * E-191/E-194 — the dealer-declared battery spec's body→column mapping.
 *
 * The rule this file exists to defend is the PATCH contract in line-spec.ts's
 * header: absent = leave the column alone, null = clear it, value = set it. A
 * mapper that quietly writes a column nobody mentioned destroys data the dealer
 * gave us, and it does it silently — the request succeeds.
 *
 * E-194 first shipped a write-time IOT-brand default that broke exactly that:
 * `blankBrand(undefined)` is true, so ANY patch omitting iot_brand_name
 * overwrote a real brand with a guess.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_IOT_BRAND,
  resolveIotBrand,
  specColumnsFromBody,
  lineSpecSchema,
} from "../line-spec";

describe("PATCH semantics: absent means leave alone", () => {
  it("omits every column the body did not mention", () => {
    const out = specColumnsFromBody(lineSpecSchema.parse({ brand: "Exide" }));
    expect(out).toEqual({ brand: "Exide" });
    // Not `undefined` values — absent KEYS, so drizzle's .set() never names them.
    expect(Object.keys(out)).toEqual(["brand"]);
  });

  it("does not touch iot_brand_name when the body only sets iot_battery", () => {
    // The regression: a line stored as iot_battery=true with brand 'BoltIoT'
    // patched with {iot_battery:true, brand:'Exide'} had BoltIoT overwritten
    // with 'Intellicar', because an absent key read as blank.
    const out = specColumnsFromBody(
      lineSpecSchema.parse({ iot_battery: true, brand: "Exide" }),
    );
    expect("iot_brand_name" in out).toBe(false);
    expect(out.iot_battery).toBe(true);
  });

  it("clears a brand the dealer explicitly nulled", () => {
    const out = specColumnsFromBody(lineSpecSchema.parse({ iot_brand_name: null }));
    expect(out.iot_brand_name).toBeNull();
  });

  it("stores a whitespace-only brand as null, not as an empty string", () => {
    const out = specColumnsFromBody(
      lineSpecSchema.parse({ iot_battery: true, iot_brand_name: "   " }),
    );
    expect(out.iot_brand_name).toBeNull();
  });

  it("keeps a brand the dealer actually named", () => {
    const out = specColumnsFromBody(
      lineSpecSchema.parse({ iot_battery: true, iot_brand_name: "BoltIoT" }),
    );
    expect(out.iot_brand_name).toBe("BoltIoT");
  });

  it("never writes the assumed brand to the column", () => {
    // The assumption is a read-time concern. If it reaches a column, the null
    // that distinguishes "assumed" from "unanswered" is gone for good.
    const bodies = [
      { iot_battery: true },
      { iot_battery: true, iot_brand_name: null },
      { iot_battery: true, iot_brand_name: "" },
      { iot_battery: true, iot_brand_name: "  " },
    ];
    for (const body of bodies) {
      const out = specColumnsFromBody(lineSpecSchema.parse(body));
      expect(out.iot_brand_name ?? null).not.toBe(DEFAULT_IOT_BRAND);
    }
  });
});

describe("resolveIotBrand marks the guess as a guess", () => {
  it("reports the dealer's own answer as not assumed", () => {
    expect(resolveIotBrand(true, "BoltIoT")).toEqual({ brand: "BoltIoT", assumed: false });
  });

  it("assumes Intellicar when the dealer left it blank", () => {
    for (const blank of [null, undefined, "", "   "]) {
      expect(resolveIotBrand(true, blank)).toEqual({
        brand: DEFAULT_IOT_BRAND,
        assumed: true,
      });
    }
  });

  it("distinguishes a dealer who typed Intellicar from one who said nothing", () => {
    // The whole point. These two must not be the same record.
    expect(resolveIotBrand(true, "Intellicar")).toEqual({
      brand: "Intellicar",
      assumed: false,
    });
    expect(resolveIotBrand(true, null)).toEqual({ brand: "Intellicar", assumed: true });
  });

  it("has nothing to say about a non-IOT battery", () => {
    expect(resolveIotBrand(false, null)).toBeNull();
    expect(resolveIotBrand(null, null)).toBeNull();
    // Even if a stale brand is still sitting on the row.
    expect(resolveIotBrand(false, "BoltIoT")).toBeNull();
  });
});
