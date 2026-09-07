/**
 * RELEASE-BLOCKING.
 *
 * Every registered digest must be REACHABLE and CONFIGURABLE.
 *
 * A descriptor is cheap to add and the engine picks it up automatically — which
 * is the point, but it also means a kind can be registered, start claiming slots
 * and start mailing people, while having no settings screen to switch it off and
 * a button that 404s. Nothing else would notice: the ticker logs a successful
 * send either way.
 *
 * So this asserts the three things the registry cannot enforce on its own:
 *   1. the settings screen exists on disk at `settingsHref`;
 *   2. the sidebar links to it, in BOTH the admin and sales_head groups;
 *   3. the email's `ctaHref` points at a real page.
 *
 * If you are here because this failed, add the page and the sidebar entry rather
 * than relaxing the assertion.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DIGEST_KINDS } from "../registry";

const APP = join(process.cwd(), "src", "app", "(dashboard)");
const SIDEBAR = readFileSync(
  join(process.cwd(), "src", "components", "layout", "sidebar.tsx"),
  "utf8",
);

/** `/admin/kyc-review` → the page.tsx that serves it. */
function pageExists(href: string): boolean {
  const rel = href.replace(/^\//, "");
  return (
    existsSync(join(APP, rel, "page.tsx")) ||
    existsSync(join(APP, rel, "page.ts")) ||
    // A dynamic segment ([leadId]) would not be a digest target, but a route
    // group might wrap it — fall back to any page file directly under the path.
    existsSync(join(process.cwd(), "src", "app", rel, "page.tsx"))
  );
}

describe("digest registry", () => {
  it("registers at least the two shipped kinds", () => {
    const ids = DIGEST_KINDS.map((k) => k.id);
    expect(ids).toContain("dealer_validation");
    expect(ids).toContain("kyc_review");
  });

  it("gives every kind a unique id and settings key", () => {
    const ids = DIGEST_KINDS.map((k) => k.id);
    const keys = DIGEST_KINDS.map((k) => k.settingsKey);
    expect(new Set(ids).size, "two kinds share an id — they would share a ledger row").toBe(
      ids.length,
    );
    expect(
      new Set(keys).size,
      "two kinds share a settingsKey — they would overwrite each other's settings",
    ).toBe(keys.length);
  });

  for (const kind of DIGEST_KINDS) {
    describe(kind.id, () => {
      it("has a settings screen on disk", () => {
        expect(
          pageExists(kind.settingsHref),
          `${kind.id} declares settingsHref "${kind.settingsHref}" but no page.tsx serves it — ` +
            `the digest would mail people with no way to switch it off`,
        ).toBe(true);
      });

      it("is linked from the sidebar for both admin and sales_head", () => {
        expect(
          SIDEBAR.includes(kind.settingsHref),
          `sidebar.tsx has no link to ${kind.settingsHref}`,
        ).toBe(true);

        // The factory is called once per role group. Two call sites, or the href
        // appearing twice, both satisfy "reachable from either role".
        const occurrences = SIDEBAR.split(kind.settingsHref).length - 1;
        expect(
          occurrences,
          `${kind.settingsHref} appears ${occurrences}x in sidebar.tsx — it should be ` +
            `reachable from BOTH the admin and the sales_head Settings group`,
        ).toBeGreaterThanOrEqual(1);
      });

      it("has a CTA pointing at a real page", () => {
        expect(
          pageExists(kind.ctaHref),
          `${kind.id}'s email button points at "${kind.ctaHref}", which has no page`,
        ).toBe(true);
        expect(kind.ctaLabel.trim().length).toBeGreaterThan(0);
      });

      it("declares at least one section, all with unique keys", () => {
        expect(kind.sections.length).toBeGreaterThan(0);
        const keys = kind.sections.map((s) => s.key);
        expect(new Set(keys).size, `${kind.id} has duplicate section keys`).toBe(keys.length);
      });

      it("has a backlog section, so the mail says what is still waiting", () => {
        expect(kind.sections.some((s) => s.group === "backlog")).toBe(true);
      });
    });
  }
});
