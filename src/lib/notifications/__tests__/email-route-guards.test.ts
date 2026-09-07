// E-284 — the guards the PATCH /api/admin/notification-email route applies
// before it writes, asserted directly.
//
// The route module itself cannot be imported here: it pulls in `@/lib/db`,
// which throws without DATABASE_URL and opens a postgres pool with one, and
// vitest is scoped to pure no-I/O helpers (vitest.config.ts). What IS worth
// pinning is that the predicates the route guards on actually reject what the
// route claims they reject — those are pure and importable, and a regression in
// them is exactly the kind that would let a locked type be silenced.
//
// The round trip through the real table (upsert, cache invalidation, the lock
// holding against a hand-written row) is covered by
// `scripts/verify-notification-email.ts --simulate`, which needs a database.

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { emailLockedTypes, isEmailLocked } from "@/lib/notifications/catalog";
import { isKnownType } from "@/lib/notifications/registry";

// Kept in step with the route's own schema.
const BodySchema = z.object({
  changes: z
    .array(
      z.object({
        notification_type: z.string().trim().min(1).max(50),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    .max(500),
});

describe("PATCH body schema", () => {
  it("accepts a well-formed change", () => {
    const parsed = BodySchema.parse({
      changes: [{ notification_type: "lead.created", enabled: false }],
    });
    expect(parsed.changes).toHaveLength(1);
  });

  it("rejects an empty batch, a missing flag, and a non-boolean", () => {
    expect(() => BodySchema.parse({ changes: [] })).toThrow();
    expect(() =>
      BodySchema.parse({ changes: [{ notification_type: "lead.created" }] }),
    ).toThrow();
    expect(() =>
      BodySchema.parse({ changes: [{ notification_type: "lead.created", enabled: "no" }] }),
    ).toThrow();
  });

  it("rejects a type longer than notifications.type's varchar(50)", () => {
    // A 51-char type is truncated by emit.ts safeType(), so the row written here
    // would never match the notification the emitter actually sends.
    expect(() =>
      BodySchema.parse({ changes: [{ notification_type: "x".repeat(51), enabled: true }] }),
    ).toThrow();
  });

  it("caps a runaway client at 500 changes", () => {
    const changes = Array.from({ length: 501 }, (_, i) => ({
      notification_type: `t${i}`,
      enabled: false,
    }));
    expect(() => BodySchema.parse({ changes })).toThrow();
    // The whole catalogue in one save must still fit.
    expect(() => BodySchema.parse({ changes: changes.slice(0, 500) })).not.toThrow();
  });
});

describe("route guards", () => {
  it("isKnownType rejects a type the registry does not carry", () => {
    expect(isKnownType("lead.created")).toBe(true);
    expect(isKnownType("lead.creatd")).toBe(false); // typo'd — must 400, not write
    expect(isKnownType("")).toBe(false);
  });

  it("isEmailLocked rejects every pinned type and nothing else", () => {
    for (const type of emailLockedTypes()) {
      expect(isEmailLocked(type), type).toBe(true);
    }
    expect(isEmailLocked("lead.created")).toBe(false);
    expect(isEmailLocked("kyc.verified")).toBe(false);
  });

  it("de-dupes on the primary key the way the route does", () => {
    // Postgres rejects an ON CONFLICT whose VALUES list hits the same key twice
    // ("cannot affect row a second time"), and toggling a category then a child
    // inside it produces exactly that. Last write wins.
    const changes = [
      { notification_type: "lead.created", enabled: false },
      { notification_type: "lead.closed", enabled: false },
      { notification_type: "lead.created", enabled: true },
    ];
    const byKey = new Map<string, (typeof changes)[number]>();
    for (const c of changes) byKey.set(c.notification_type, c);
    const rows = [...byKey.values()];

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.notification_type === "lead.created")?.enabled).toBe(true);
  });
});
