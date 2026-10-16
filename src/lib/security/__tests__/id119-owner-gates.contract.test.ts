/**
 * Tracker ID 119 (decided 16 Oct) — source-text contract: below Admin, CEO and
 * Sales Head, the admin KYC lists show only owned customers, and the per-lead
 * admin routes check the owner, not just the role. The routes import the
 * database, so this reads their source.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const API_DIR = join(process.cwd(), "src", "app", "api");

const code = (route: string) =>
  readFileSync(join(API_DIR, ...route.split("/"), "route.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("ID 119 — admin KYC lists are cut to owned customers", () => {
  it.each(["admin/kyc-reviews", "admin/kyc/queue"])("%s filters with ownedLeadsWhere", (route) => {
    expect(code(route)).toMatch(/ownedLeadsWhere\(/);
  });

  it("a KYC review decision checks the owner of the lead", () => {
    expect(code("admin/kyc-reviews")).toMatch(/backOfficeMayReachLead\(admin, leadId\)/);
  });
});

describe("ID 119 — per-lead admin routes check the owner", () => {
  const OWNER_GATED = [
    "admin/kyc/[leadId]/consent/[consentId]/fetch-pdf",
    "admin/kyc/[leadId]/cancel-verification",
    "kyc/[leadId]/consent/admin",
  ];
  it.each(OWNER_GATED)("%s calls backOfficeMayReachLead", (route) => {
    expect(code(route)).toMatch(/backOfficeMayReachLead\(/);
  });

  it("fetch-pdf only fetches a consent of the lead in the URL", () => {
    expect(code("admin/kyc/[leadId]/consent/[consentId]/fetch-pdf")).toMatch(
      /eq\(consentRecords\.id, consentId\), eq\(consentRecords\.lead_id, leadId\)/,
    );
  });

  const LEAD_ROUTES = [
    "sanction-loan",
    "reject-loan",
    "manual-handoff",
    "manual-handoff/send",
    "manual-handoff/outcome",
    "recall",
    "resubmit",
    "product-selection",
    "financing-unavailable",
  ];
  it.each(LEAD_ROUTES)("admin/lead/[id]/%s uses requireAdminAppUserForLead", (route) => {
    const src = code(`admin/lead/[id]/${route}`);
    expect(src).toMatch(/requireAdminAppUserForLead\(\(await params\)\.id\)/);
    expect(src).not.toMatch(/requireAdminAppUser\(\)/);
  });
});
