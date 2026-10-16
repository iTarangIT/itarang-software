/**
 * Tracker ID 166 (decided 10 Oct) — source-text contract for the routes that
 * hand customer files and expense bills around. The routes import the
 * database, so this reads their source.
 *   - the admin NBFC request routes act only for Admin, Sales Head, CEO and the
 *     lead's owner;
 *   - the AI expense ZIP (copies of the bills) is for Finance, Admin and CEO;
 *     the tracker list and the CEO ledger blank other people's bill links;
 *   - every upload of a co-borrower file or a requested document records who
 *     uploaded it (E-349).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const API_DIR = join(SRC, "app", "api");

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const route = (r: string) => strip(readFileSync(join(API_DIR, ...r.split("/"), "route.ts"), "utf8"));
const lib = (p: string) => strip(readFileSync(join(SRC, ...p.split("/")), "utf8"));

describe("ID 166 — admin NBFC request routes check the lead's owner", () => {
  const ROUTES = [
    "admin/nbfc-requests",
    "admin/nbfc-requests/rejections",
    "admin/nbfc-requests/rejections/[assignmentId]/forward",
    "admin/nbfc-requests/verdicts/[verdictId]/forward",
    "admin/nbfc-requests/verdicts/[verdictId]/respond",
    "admin/nbfc-requests/[id]/act",
    "admin/nbfc-requests/[id]/forward",
    "admin/nbfc-requests/[id]/fulfil",
    "admin/nbfc-requests/[id]/push",
    "admin/nbfc-requests/[id]/request-coborrower",
  ];
  it.each(ROUTES)("%s", (r) => {
    expect(route(r)).toMatch(/adminMayActOnNbfcLead\(|nbfcObjectGate\(/);
  });
});

describe("ID 166 — expense bills", () => {
  it("the AI expense ZIP is for Finance, Admin and CEO, not the tracker's admin list", () => {
    const src = route("admin/ai-expenses/export");
    expect(src).toMatch(/mayOpenAllExpenseBills\(user\.role\)/);
    expect(src).not.toMatch(/requireApiAdmin/);
  });

  it.each(["admin/ai-expenses", "dashboard/ceo/expense-ledger"])("%s blanks bill links the viewer may not open", (r) => {
    expect(route(r)).toMatch(/withAllowedBill\(/);
  });
});

describe("ID 166 — uploads record who uploaded (E-349)", () => {
  // The three dealer-portal upload routes are pinned in
  // id166-portal-upload-stamp.contract.test.ts.
  it.each(["public/upload-docs/[leadId]/[requestId]/[token]"])("%s", (r) => {
    expect(route(r)).toMatch(/stampUploader\(/);
  });

  it.each(["lib/whatsapp/coborrower-flow.ts", "lib/whatsapp/doc-request-flow.ts", "lib/whatsapp/extra-docs-flow.ts"])(
    "%s",
    (p) => {
      expect(lib(p)).toMatch(/stampUploader\(/);
    },
  );

  it("the customer's public-link upload is not the dealer's", () => {
    expect(route("public/upload-docs/[leadId]/[requestId]/[token]")).toMatch(/userId: null, source: 'public_link'/);
  });
});
