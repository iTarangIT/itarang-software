/**
 * Tracker ID 166, the report places still open after the 18 Oct check
 * (closed 22 Oct) — source-text contract for routes that import the database:
 *   - recordings: no screen hands out a provider's open recording link; AI
 *     calls go through /api/ai-dialer/recording, touchpoints (NeoDove, manual
 *     calls) through the new /api/lead-touchpoints/<id>/recording;
 *   - the AI expense tracker reaches Finance and the CEO, and its export's
 *     Bill URL column is a checked CRM link;
 *   - the WhatsApp onboarding drawer shows documents only to Admin, Sales
 *     Head, CEO and the application's owner (not any partner login).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const src = (p: string) => strip(readFileSync(join(SRC, ...p.split("/")), "utf8"));

describe("ID 166 — recordings never leave as the provider's link", () => {
    it.each([
        "app/api/ai-dialer/campaigns/[id]/leads/[leadId]/transcript/route.ts",
        "app/api/dealer-leads/[id]/ai-summary/route.ts",
        "app/api/sales-insight/detail/ai-dialer/[id]/route.ts",
        "app/api/sales-insight/detail/b2b/[id]/route.ts",
        "lib/ai-dialer/aiConnection.ts",
        "lib/ai-dialer/leadCallAttempts.ts",
        "lib/leads/normalizeCalls.ts",
    ])("%s routes recordings through callRecordingLink", (p) => {
        const code = src(p);
        expect(code).toMatch(/callRecordingLink\(/);
        // The old pattern: the stored link first, whatever it is.
        expect(code).not.toMatch(/recording_url\s*\?\?\s*\n?\s*\(/);
        expect(code).not.toMatch(/recordingUrl\s*\?\?\s*\n?\s*\(\s*latest/);
    });

    it("the lead page timeline maps every touchpoint recording through touchpointRecordingLink", () => {
        expect(src("app/(dashboard)/leads/[id]/page.tsx")).toMatch(
            /touchpoints = touchpoints\.map\([\s\S]*?touchpointRecordingLink\(t\.touchpoint_id, t\.recording_url\)/,
        );
    });

    it("the touchpoint play route copies, checks the file rule, and signs for this user", () => {
        const code = src("app/api/lead-touchpoints/[touchpointId]/recording/route.ts");
        expect(code).toMatch(/guardApi\(\[\.\.\.LEADS_PAGE_ROLES\]\)/);
        expect(code).toMatch(/readsOwnLeadsOnly\(authGate\.user\.role\)/);
        expect(code).toMatch(/ownRecordingUrl\(/);
        expect(code).toMatch(/canOpenStoredFile\(authGate\.user/);
        expect(code).toMatch(/signedFilePath\(filesProxyPath\(ref\.bucket, ref\.key\), FRESH_LINK_TTL_SECONDS, \{ by: authGate\.user\.id \}\)/);
        // Never a redirect to the stored provider link.
        expect(code).not.toMatch(/Location: row\.recording_url/);
    });
});

describe("ID 166 — expense tracker for Finance and the CEO", () => {
    it("API, page and middleware share one role list incl. ceo and finance_controller", () => {
        expect(src("lib/auth/requireApiAdmin.ts")).toMatch(
            /EXPENSE_ADMIN_ROLES = \["admin", "sales_head", "ceo", "finance_controller"\]/,
        );
        expect(src("app/(dashboard)/admin/expense-tracker/page.tsx")).toMatch(/requireRole\(\[\.\.\.EXPENSE_ADMIN_ROLES\]\)/);
        expect(src("middleware.ts")).toMatch(
            /"\/admin\/expense-tracker": \["admin", "sales_head", "ceo", "finance_controller"\]/,
        );
    });

    it("the export's Bill URL cell is a checked CRM link, not the stored one", () => {
        const code = src("app/api/admin/ai-expenses/export/route.ts");
        expect(code).toMatch(/bill_url: billCell\(r\.bill_url, origin\)/);
        expect(code).not.toMatch(/bill_url: r\.bill_url \?\? ""/);
    });

    it("the checked link a spreadsheet carries redirects relatively (never to the proxy's localhost origin)", () => {
        const code = src("app/api/files/open/route.ts");
        expect(code).not.toMatch(/nextUrl\.origin/);
        expect(code).toMatch(/return redirectHere\("\/login"\)/);
        expect(code).toMatch(/return redirectHere\(fresh \?\? target\.path\)/);
    });

    it("the list still blanks bill links the viewer may not open (Sales Head: own only)", () => {
        expect(src("app/api/admin/ai-expenses/route.ts")).toMatch(/withAllowedBill\(/);
    });
});

describe("ID 166 — WhatsApp onboarding drawer documents", () => {
    it("documents only for the Dealer Validation readers or the application's owner", () => {
        const code = src("app/api/admin/whatsapp-onboarding/conversations/[applicationId]/route.ts");
        expect(code).toMatch(/mayReadDealerApplication\(\{ role: user\.role, userId: user\.id \}\)/);
        expect(code).toMatch(/ownsDealerApplication\(user\.id/);
        expect(code).toMatch(/documentsHidden: !seesDocuments/);
        expect(code).toMatch(/\(seesDocuments \? Array\.from\(latestPerType\.values\(\)\) : \[\]\)/);
    });
});
