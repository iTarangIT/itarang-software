// E-282 — the email channel's precedence rule.
//
// Tests `resolveEmailChannel` and not `email-access.ts`, deliberately: that
// module imports `@/lib/db`, which throws without DATABASE_URL and opens a
// postgres pool when it has one. Vitest here is scoped to pure, no-I/O helpers
// (vitest.config.ts), so the rule was extracted into catalog.ts precisely so it
// could be asserted without either. The cache mechanics around it are the same
// single-flight/TTL shape as access.ts and are exercised by running the app.

import { describe, expect, it } from "vitest";

import {
  emailLockedTypes,
  emailWorthy,
  isEmailLocked,
  resolveEmailChannel,
} from "@/lib/notifications/catalog";
import { allGovernableTypes, isKnownType } from "@/lib/notifications/registry";

const NONE = undefined;

describe("resolveEmailChannel", () => {
  it("falls through to the code default when nobody has decided", () => {
    // The whole safety story of E-282 rests on this: an unapplied migration, a
    // dropped connection or a fresh install all produce an empty override map,
    // and every type must then answer exactly as it did before E-282 existed.
    for (const type of allGovernableTypes()) {
      const expected = isEmailLocked(type) ? true : emailWorthy(type);
      expect(resolveEmailChannel(type, NONE, NONE), type).toBe(expected);
    }
  });

  it("lets a saved override switch a type off, and back on", () => {
    // lead.created is emailed by default; kyc.verified is in NO_EMAIL.
    expect(resolveEmailChannel("lead.created", NONE, NONE)).toBe(true);
    expect(resolveEmailChannel("lead.created", false, NONE)).toBe(false);

    expect(resolveEmailChannel("kyc.verified", NONE, NONE)).toBe(false);
    expect(resolveEmailChannel("kyc.verified", true, NONE)).toBe(true);
  });

  it("lets the saved override beat a per-recipient email:false", () => {
    // product.dispatched is one of the three types events.ts suppresses per
    // audience. An admin who ticks it on must see it actually send, or the
    // settings screen is lying about the current state.
    expect(resolveEmailChannel("product.dispatched", NONE, false)).toBe(false);
    expect(resolveEmailChannel("product.dispatched", true, false)).toBe(true);
    expect(resolveEmailChannel("product.dispatched", false, false)).toBe(false);
  });

  it("honours a per-recipient flag when no override is saved", () => {
    expect(resolveEmailChannel("nbfc.wallet_low", NONE, false)).toBe(false);
    expect(resolveEmailChannel("kyc.verified", NONE, true)).toBe(true);
  });

  it("never lets a locked type be switched off, by any route", () => {
    for (const type of emailLockedTypes()) {
      expect(resolveEmailChannel(type, false, false), type).toBe(true);
      expect(resolveEmailChannel(type, false, NONE), type).toBe(true);
      expect(resolveEmailChannel(type, NONE, false), type).toBe(true);
    }
  });

  it("treats an unmapped type as emailable, matching emailWorthy", () => {
    // A type added to events.ts before the registry catches up must not silently
    // stop emailing — same fail-open posture as the rest of this subsystem.
    expect(resolveEmailChannel("some.brand_new_event", NONE, NONE)).toBe(true);
  });
});

describe("EMAIL_LOCKED", () => {
  it("names only types the registry actually knows", () => {
    // A typo here is invisible at runtime and silently UNLOCKS a critical email:
    // the intended type falls through to the ordinary rules and can be unticked.
    for (const type of emailLockedTypes()) {
      expect(isKnownType(type), `${type} is not a known notification type`).toBe(true);
    }
  });

  it("does not lock a type the code deliberately suppresses", () => {
    // Locking a NO_EMAIL member would START sending an email that was switched
    // off for a reason — the one way this feature could change behaviour on the
    // day it ships, rather than only when an admin acts.
    for (const type of emailLockedTypes()) {
      expect(emailWorthy(type), `${type} is locked ON but NO_EMAIL suppresses it`).toBe(
        true,
      );
    }
  });
});
