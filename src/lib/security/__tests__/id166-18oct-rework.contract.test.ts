/**
 * Tracker ID 166, the 18 Oct "still missing / rework" items — source-text
 * contract for routes that import the database:
 *   - item 5: buyback files for Admin, CEO, Sales Head and the partner (not
 *     the Business Head);
 *   - item 6: call reviews (recordings list, transcripts, the Sales Insight
 *     drawer's latest call) only for Admin, Sales Head, CEO and the owner;
 *   - item 8: the Aadhaar autofill scans go through the checked proxy, never
 *     a signed storage link;
 *   - item 9: no stored file is cached by the browser;
 *   - item 11: the Dealer Validation page reads for Admin and the account's
 *     owner too, the actions stay with Sales Head and CEO;
 *   - item 12: the dealer-facing file lists mark what the dealer cannot open;
 *   - WhatsApp uploads record the dealer as uploader (else item 1 would hide a
 *     dealer's own WhatsApp uploads from it).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const API_DIR = join(SRC, "app", "api");

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const route = (r: string) => strip(readFileSync(join(API_DIR, ...r.split("/"), "route.ts"), "utf8"));
const src = (p: string) => strip(readFileSync(join(SRC, ...p.split("/")), "utf8"));

/** The body of one exported handler (up to the next export). */
function handler(code: string, method: string): string {
    const at = code.search(new RegExp(`export (?:async function|const) ${method}\\b`));
    if (at === -1) return "";
    const next = code.slice(at + 10).search(/\nexport /);
    return next === -1 ? code.slice(at) : code.slice(at, at + 10 + next);
}

describe("item 5 — buyback files", () => {
    it.each(["buyback/media", "buyback/requests/[id]/photos"])("%s decides on the buyback FILE roles", (r) => {
        const code = route(r);
        expect(code).toMatch(/isBuybackFileRole\(/);
        expect(code).not.toMatch(/isBuybackAdminRole\(/);
    });
});

describe("item 6 — call reviews", () => {
    it("the attached-recordings list is empty for a non-owner below the top roles", () => {
        const get = handler(route("dealer-leads/[id]/recordings"), "GET");
        expect(get).toMatch(/!seesEveryCallReview\(user\.role\) && !\(await leadVisibleTo\(leadId, user\.id\)\)/);
        expect(get).toMatch(/recordings: \[\], hidden: true/);
    });

    it("the AI summary drops transcript and recording for a non-owner", () => {
        const code = route("dealer-leads/[id]/ai-summary");
        expect(code).toMatch(/const mayReview = seesEveryCallReview\(user\.role\) \|\| \(await leadVisibleTo\(id, user\.id\)\)/);
        expect(code).toMatch(/const includeTranscript = mayReview &&/);
        expect(code).toMatch(/recordingUrl: !mayReview\s*\?\s*null/);
    });

    it.each(["sales-insight/detail/ai-dialer/[id]", "sales-insight/detail/b2b/[id]"])(
        "%s strips the latest call's review unless the viewer owns the lead",
        (r) => {
            const code = route(r);
            expect(code).toMatch(/mayReadCallReview\(/);
            expect(code).toMatch(/latest_call: review\(/);
        },
    );
});

describe("item 8 — Aadhaar autofill scans", () => {
    it("the documents link route hands out the checked proxy path, not a signed storage link", () => {
        const code = route("documents/signed-url");
        expect(code).not.toMatch(/signObject\(|createSignedUrl\(/);
        expect(code).toMatch(/filesProxyPath\(PRIVATE_FILE_BUCKET/);
        expect(code).toMatch(/signedFilePath\(path, FRESH_LINK_TTL_SECONDS, \{ by: user\.id \}\)/);
    });

    it("the files proxy serves private-documents", () => {
        expect(src("lib/storage/fileAccess.ts")).toMatch(/FILE_PROXY_BUCKETS = \[[^\]]*"private-documents"/);
        expect(route("files/[bucket]/[...path]")).toMatch(/new Set<string>\(FILE_PROXY_BUCKETS\)/);
    });
});

describe("item 9 — no stored file is cached", () => {
    it("the files proxy sends no-store for every file", () => {
        const code = route("files/[bucket]/[...path]");
        expect(code).toMatch(/"Cache-Control": "private, no-store"/);
        expect(code).not.toMatch(/max-age/);
    });

    it.each([
        "buyback/media",
        "buyback/requests/[id]/po",
        "feature-requests/attachments/[attachmentId]",
        "vendor/threads/[id]/photo",
    ])("%s sends no-store", (r) => {
        const code = route(r);
        expect(code).toMatch(/"Cache-Control": "private, no-store"/);
        expect(code).not.toMatch(/max-age/);
    });
});

describe("item 11 — Dealer Validation page", () => {
    const DIR = join(API_DIR, "admin", "dealer-verifications");
    const files: string[] = [];
    (function walk(d: string) {
        for (const f of readdirSync(d)) {
            const p = join(d, f);
            if (statSync(p).isDirectory()) walk(p);
            else if (f === "route.ts") files.push(p);
        }
    })(DIR);

    const READ_ONLY = new Set([
        "route.ts",
        "summary/route.ts",
        "export/route.ts",
        "[dealerId]/route.ts",
        "[dealerId]/agreement-tracking/route.ts",
        "[dealerId]/agreement-documents/route.ts",
        "[dealerId]/agreement-documents/[docId]/route.ts",
        "[dealerId]/audit-trail/route.ts",
        "[dealerId]/duplicate-check/route.ts",
        "[dealerId]/download-signed-agreement/route.ts",
    ]);

    it("every GET reads through requireDealerValidationReader", () => {
        const wrong: string[] = [];
        for (const f of files) {
            const get = handler(strip(readFileSync(f, "utf8")), "GET");
            if (get && !/requireDealerValidationReader\(/.test(get)) wrong.push(relative(DIR, f));
        }
        expect(wrong).toEqual([]);
    });

    it("every action (POST / PATCH / PUT / DELETE) stays requireSalesHead", () => {
        const wrong: string[] = [];
        for (const f of files) {
            const code = strip(readFileSync(f, "utf8"));
            for (const m of ["POST", "PATCH", "PUT", "DELETE"]) {
                const h = handler(code, m);
                if (h && (!/requireSalesHead\(\)/.test(h) || /requireDealerValidationReader\(/.test(h))) {
                    wrong.push(`${relative(DIR, f)} ${m}`);
                }
            }
        }
        expect(wrong).toEqual([]);
    });

    it("the read-only list is exactly the GET routes", () => {
        const withGet = files
            .filter((f) => handler(strip(readFileSync(f, "utf8")), "GET"))
            .map((f) => relative(DIR, f).replace(/\\/g, "/"));
        expect(withGet.sort()).toEqual([...READ_ONLY].sort());
    });

    it("the queue narrows an owner to its own applications; summary and export are whole-queue only", () => {
        expect(route("admin/dealer-verifications")).toMatch(/auth\.scope === "own"/);
        expect(route("admin/dealer-verifications/summary")).toMatch(/requireDealerValidationReader\(undefined, \{ allOnly: true \}\)/);
        expect(route("admin/dealer-verifications/export")).toMatch(/requireDealerValidationReader\(undefined, \{ allOnly: true \}\)/);
    });

    it("middleware lets the readers onto the page", () => {
        expect(src("middleware.ts")).toMatch(/"\/admin\/dealer-verification": \[\.\.\.DEALER_VALIDATION_PAGE_ROLES\]/);
    });
});

describe("item 12 — dealer-facing file lists", () => {
    it.each(["kyc/[leadId]/documents", "coborrower/[leadId]/documents", "kyc/[leadId]/requested-docs"])(
        "%s marks the files a dealer may not open",
        (r) => {
            const get = handler(route(r), "GET");
            expect(get).toMatch(/dealerViewableFiles\(/);
            expect(get).toMatch(/file_viewable: viewable\(/);
        },
    );
});

describe("item 1 — WhatsApp uploads record the dealer", () => {
    it("customer documents from the dealer's console carry the dealer as uploader", () => {
        const code = src("lib/whatsapp/orchestrator.ts");
        expect(code).toMatch(/uploaded_by: uploaderId,/);
        expect(code).toMatch(/const uploaderId = consoleUpload \? dealer\.uploaderId : null;/);
        expect(code).toMatch(/onLeadDocs\(session, event, houseDealer, false\)/);
    });

    it("co-borrower KYC rows from WhatsApp carry the dealer as uploader", () => {
        expect(src("lib/whatsapp/coborrower-flow.ts")).toMatch(/uploaded_by: await whatsappUploaderId\(opts\.applicationId\)/);
    });
});
