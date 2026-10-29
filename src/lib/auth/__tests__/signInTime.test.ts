import { describe, expect, it } from "vitest";

import { signInTimeFromClaims } from "../signInTime";

describe("signInTimeFromClaims (ID 206)", () => {
  it("reads the password sign-in time from amr", () => {
    expect(signInTimeFromClaims({ amr: [{ method: "password", timestamp: 1_761_640_000 }] })).toBe(
      new Date(1_761_640_000 * 1000).toISOString(),
    );
  });

  it("takes the latest method when there are several", () => {
    const amr = [
      { method: "password", timestamp: 1_761_640_000 },
      { method: "otp", timestamp: 1_761_640_120 },
    ];
    expect(signInTimeFromClaims({ amr })).toBe(new Date(1_761_640_120 * 1000).toISOString());
  });

  it("is undefined without a usable timestamp", () => {
    expect(signInTimeFromClaims(null)).toBeUndefined();
    expect(signInTimeFromClaims({})).toBeUndefined();
    expect(signInTimeFromClaims({ amr: ["password"] })).toBeUndefined();
    expect(signInTimeFromClaims({ amr: [{ method: "password" }] })).toBeUndefined();
    expect(signInTimeFromClaims({ amr: [{ method: "password", timestamp: "x" }] })).toBeUndefined();
  });
});
