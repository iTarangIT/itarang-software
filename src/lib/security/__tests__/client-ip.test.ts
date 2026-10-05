import { describe, expect, it } from "vitest";

import { clientIp } from "../client-ip";

/**
 * clientIp() feeds the ban gate in middleware: the address it returns is the
 * one that collects strikes and the one that gets refused. So which header
 * wins is an auth decision, not a logging detail.
 */
const from = (headers: Record<string, string>) => clientIp(new Headers(headers));

describe("clientIp", () => {
  it("returns nothing when no proxy header is present", () => {
    expect(from({})).toMatchObject({ ip: null, source: null, clientSuppliedForwardedFor: false });
  });

  it("uses the address nginx wrote, not the one the client sent", () => {
    const got = from({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4, 203.0.113.9" });
    expect(got.ip).toBe("203.0.113.9");
    expect(got.source).toBe("x-real-ip");
  });

  it("without x-real-ip takes the RIGHTMOST forwarded entry — the leftmost is the client's claim", () => {
    const got = from({ "x-forwarded-for": "1.2.3.4, 5.6.7.8 , 203.0.113.9" });
    expect(got.ip).toBe("203.0.113.9");
    expect(got.ip).not.toBe("1.2.3.4");
    expect(got.clientSuppliedForwardedFor).toBe(true);
  });

  it("does not flag a single forwarded entry as client-supplied", () => {
    expect(from({ "x-forwarded-for": "203.0.113.9" }).clientSuppliedForwardedFor).toBe(false);
  });

  it("falls back to x-client-ip only when nothing else is present", () => {
    expect(from({ "x-client-ip": "198.51.100.7" }).source).toBe("x-client-ip");
    expect(from({ "x-client-ip": "198.51.100.7", "x-real-ip": "203.0.113.9" }).ip).toBe("203.0.113.9");
  });

  it("keeps every header it saw, so a spoof attempt is visible afterwards", () => {
    const got = from({ "cf-connecting-ip": "9.9.9.9", "x-real-ip": "203.0.113.9" });
    expect(got.chain).toEqual({ "cf-connecting-ip": "9.9.9.9", "x-real-ip": "203.0.113.9" });
  });

  it("KNOWN GAP: cf-connecting-ip and true-client-ip outrank the address nginx wrote", () => {
    // These are only trustworthy behind Cloudflare / Akamai, which overwrite
    // them. The hosts sit behind nginx alone, so unless nginx strips them a
    // caller sets them freely: rotate the value and strikes never add up, or
    // send a victim's address and the victim collects the ban. Fix: prefer
    // x-real-ip unless a CDN is known to be in front.
    expect(from({ "cf-connecting-ip": "9.9.9.9", "x-real-ip": "203.0.113.9" }).ip).toBe("9.9.9.9");
    expect(from({ "true-client-ip": "9.9.9.9", "x-real-ip": "203.0.113.9" }).ip).toBe("9.9.9.9");
  });
});
