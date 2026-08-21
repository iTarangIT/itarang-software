import { describe, it, expect, vi } from "vitest";

// The modules under test import the Drizzle client, which throws at import
// time without DATABASE_URL. Nothing here touches the database.
vi.mock("@/lib/db", () => ({ db: {} }));

import { backoffMs } from "./drive-mirror";
import { normalizeDriveMirrorSettings } from "./drive-mirror-settings";
import { describeDriveError } from "@/lib/google/drive";

describe("E-255 drive mirror", () => {
    it("backs off exponentially from 1 minute and caps at 6 hours", () => {
        expect(backoffMs(1)).toBe(60_000);
        expect(backoffMs(2)).toBe(120_000);
        expect(backoffMs(3)).toBe(240_000);
        expect(backoffMs(20)).toBe(6 * 60 * 60_000);
        expect(backoffMs(0)).toBe(60_000);
    });

    it("normalises settings, treating blank strings as null and keeping the base for undefined", () => {
        const base = { enabled: true, rootFolderId: "abc", impersonateUser: "x@y.z" };
        expect(normalizeDriveMirrorSettings({ rootFolderId: "  " }, base)).toEqual({
            enabled: true,
            rootFolderId: null,
            impersonateUser: "x@y.z",
        });
        expect(normalizeDriveMirrorSettings({ enabled: "yes" }, base).enabled).toBe(true); // non-boolean ignored
        expect(normalizeDriveMirrorSettings(null, base)).toEqual(base);
        expect(normalizeDriveMirrorSettings({ impersonateUser: null }, base).impersonateUser).toBeNull();
    });

    it("names the service-account storage-quota failure instead of blaming folder sharing", () => {
        const msg = describeDriveError({
            code: 403,
            message:
                "Service Accounts do not have storage quota. Leverage shared drives (https://developers.google.com/workspace/drive/api/guides/about-shareddrives), or use OAuth delegation (http://support.google.com/a/answer/7281227) instead.",
            errors: [{ reason: "storageQuotaExceeded" }],
        });
        expect(msg).toMatch(/no Drive storage of its own/);
        expect(msg).toMatch(/Shared Drive/);
        expect(msg).not.toMatch(/not being shared/);
    });
});

import {
    driveFolderPathFor,
    prettifySegment,
    driveTopLevelFolders,
    isDriveMirrorExcluded,
} from "./drive-mirror-layout";

describe("E-255 drive layout", () => {
    it("places KYC files under KYC Documents / <lead>", () => {
        expect(driveFolderPathFor("documents", "kyc/LEAD-20260430-1e082d3f/aadhaar_front.png").path).toEqual([
            "KYC Documents",
            "LEAD-20260430-1e082d3f",
        ]);
    });
    it("keeps the doc-type folder under Dealer Onboarding, prettified", () => {
        expect(driveFolderPathFor("dealer-documents", "upload-gst-certificate/abc.pdf").path).toEqual([
            "Dealer Onboarding",
            "Upload GST Certificate",
        ]);
        expect(driveFolderPathFor("dealer-documents", "4-undated-cheques/abc.pdf").path).toEqual([
            "Dealer Onboarding",
            "4 Undated Cheques",
        ]);
        expect(driveFolderPathFor("dealer-documents", "aoa-articles-of-association/x.pdf").path).toEqual([
            "Dealer Onboarding",
            "AOA Articles of Association",
        ]);
    });
    it("routes buyback / agreements / NBFC to their own categories", () => {
        expect(driveFolderPathFor("dealer-documents", "buyback/1234/photo.jpg").path).toEqual(["Battery Buyback", "1234"]);
        expect(driveFolderPathFor("dealer-documents", "agreements/6b1f2c3d-aaaa-4bbb-8ccc-0123456789ab/signed.pdf").path).toEqual(["Dealer Agreements", "6b1f2c3d-aaaa-4bbb-8ccc-0123456789ab"]);
        expect(driveFolderPathFor("nbfc-documents", "fi/77/photo.jpg").path).toEqual(["NBFC", "Field Investigation", "77"]);
        expect(driveFolderPathFor("nbfc-documents", "110/gst.pdf").path).toEqual(["NBFC", "Onboarding & Compliance", "110"]);
        expect(driveFolderPathFor("documents", "expenses/drive/inv.pdf").path).toEqual(["Expenses", "Drive"]);
    });
    it("never drops an unknown object — it goes to Other/<bucket>", () => {
        expect(driveFolderPathFor("mystery-bucket", "a/b/c.txt").path).toEqual(["Other", "mystery-bucket", "a", "b"]);
        expect(driveFolderPathFor("mystery-bucket", "a/b/c.txt").rule).toBeNull();
    });
    it("backs up only the allow-listed categories", () => {
        // included
        expect(isDriveMirrorExcluded("documents", "kyc/LEAD-1/aadhaar.png")).toBe(false);
        expect(isDriveMirrorExcluded("documents", "leads/LEAD-1/pre-sanction.pdf")).toBe(false);
        expect(isDriveMirrorExcluded("documents", "whatsapp/919999/aadhaar.jpg")).toBe(false);
        expect(isDriveMirrorExcluded("dealer-documents", "agreements/6b1f/signed.pdf")).toBe(false);
        expect(isDriveMirrorExcluded("dealer-documents", "agreement-template-file/t.pdf")).toBe(false);
        expect(isDriveMirrorExcluded("dealer-documents", "dealer-signed-agreement-upload/s.pdf")).toBe(false);
        expect(isDriveMirrorExcluded("dealer-documents", "signed-agreement.pdf")).toBe(false);
        expect(isDriveMirrorExcluded("dealer-documents", "upload-gst-certificate/x.pdf")).toBe(false);
        expect(isDriveMirrorExcluded("nbfc-documents", "agreements/1/lsp.pdf")).toBe(false);
        expect(isDriveMirrorExcluded("nbfc-documents", "110/gst.pdf")).toBe(false);
        // excluded
        expect(isDriveMirrorExcluded("call-recordings", "elevenlabs/x.mp3")).toBe(true);
        expect(isDriveMirrorExcluded("call-recordings", "bolna/y.wav")).toBe(true);
        expect(isDriveMirrorExcluded("documents", "expenses/drive/inv.pdf")).toBe(true);
        expect(isDriveMirrorExcluded("documents", "quotations/q.pdf")).toBe(true);
        expect(isDriveMirrorExcluded("documents", "auction/lot/1.jpg")).toBe(true);
        expect(isDriveMirrorExcluded("documents", "autofill/x.png")).toBe(true);
        expect(isDriveMirrorExcluded("private-documents", "lead/1/x.pdf")).toBe(true);
        expect(isDriveMirrorExcluded("dealer-documents", "buyback/1234/photo.jpg")).toBe(true);
        expect(isDriveMirrorExcluded("dealer-documents", "visit-photos/1/a.jpg")).toBe(true);
        expect(isDriveMirrorExcluded("nbfc-documents", "fi/77/photo.jpg")).toBe(true);
        expect(isDriveMirrorExcluded("nbfc-documents", "vkyc/1/rec.mp4")).toBe(true);
        expect(isDriveMirrorExcluded("mystery-bucket", "a/b/c.txt")).toBe(true);
    });
    it("prettifies segments but leaves ids and filenames alone", () => {
        expect(prettifySegment("last-3-months-company-bank-statement")).toBe("Last 3 Months Company Bank Statement");
        expect(prettifySegment("LEAD-20260430-1e082d3f")).toBe("LEAD-20260430-1e082d3f");
        expect(prettifySegment("3367db3e-6106-4b4a-947d-73295f0020de")).toBe("3367db3e-6106-4b4a-947d-73295f0020de");
        expect(prettifySegment("report.pdf")).toBe("report.pdf");
    });
    it("lists only the backed-up top-level folders", () => {
        const tops = driveTopLevelFolders();
        expect(tops).toContain("KYC Documents");
        expect(tops).toContain("Dealer Onboarding");
        expect(tops).toContain("NBFC");
        expect(tops).not.toContain("Other");
        expect(tops).not.toContain("Expenses");
        expect(tops).not.toContain("Battery Buyback");
    });
});
