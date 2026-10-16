/**
 * Tracker ID 166 (E-349) — the dealer-portal upload routes for co-borrower
 * files and requested documents record who uploaded the file, so the file
 * opener can show a dealer only its own uploads. Source-text contract (the
 * routes import the database).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const API_DIR = join(process.cwd(), "src", "app", "api");

const route = (r: string) =>
  readFileSync(join(API_DIR, ...r.split("/"), "route.ts"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("ID 166 — portal uploads record the uploader (E-349)", () => {
  it.each([
    "coborrower/[leadId]/upload-document",
    "coborrower/[leadId]/upload-other-document",
    "kyc/[leadId]/requested-docs",
  ])("%s", (r) => {
    expect(route(r)).toMatch(/stampUploader\([^)]*userId: leadGate\.user\.id, source: ["']portal["']/);
  });
});
