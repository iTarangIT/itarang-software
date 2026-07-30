import { describe, it, expect } from "vitest";
import {
    DEFAULT_EXCLUDED_FOLDER_NAMES,
    DEFAULT_INCLUDED_FOLDER_NAMES,
    folderMatchesToken,
    parseDriveFolderId,
} from "./drive";

// E-216. `folderMatchesToken` drives both the Purchase allowlist and the Sale
// denylist — together the only thing stopping the scanner booking the
// company's entire turnover as expenses (and double-counting it against the
// Zoho revenue sync). The live accounts folder names these subfolders four
// different ways across two yearly conventions, so every real variant is
// pinned down here.

describe("folderMatchesToken — Sale denylist", () => {
    const tokens = DEFAULT_EXCLUDED_FOLDER_NAMES;

    it("catches every naming variant present in the live folder", () => {
        // 2026 uses these two...
        expect(folderMatchesToken("Sale", tokens)).toBe(true);
        expect(folderMatchesToken("Sales", tokens)).toBe(true);
        // ...and these two, which an exact-name match missed.
        expect(folderMatchesToken("Sale Invoices", tokens)).toBe(true);
        expect(folderMatchesToken("Sales Invoices", tokens)).toBe(true);
    });

    it("ignores case and surrounding whitespace", () => {
        expect(folderMatchesToken("  SALES INVOICES ", tokens)).toBe(true);
        expect(folderMatchesToken("sale", tokens)).toBe(true);
    });

    it("does not match the token mid-word", () => {
        // These are not sales folders and must still be walked.
        expect(folderMatchesToken("Wholesale", tokens)).toBe(false);
        expect(folderMatchesToken("Resale Docs", tokens)).toBe(false);
        expect(folderMatchesToken("Presales", tokens)).toBe(false);
    });

    it("leaves the purchase side alone", () => {
        expect(folderMatchesToken("Purchase", tokens)).toBe(false);
        expect(folderMatchesToken("Purchase Invoices", tokens)).toBe(false);
        expect(folderMatchesToken("Other Expenses", tokens)).toBe(false);
        expect(folderMatchesToken("iTarang Account", tokens)).toBe(false);
        expect(folderMatchesToken("Trontek", tokens)).toBe(false);
    });

    it("treats an empty token list as 'exclude nothing'", () => {
        // An admin who clears the field must get what they asked for.
        expect(folderMatchesToken("Sales", [])).toBe(false);
        expect(folderMatchesToken("Sales", ["", "  "])).toBe(false);
    });

    it("accepts custom tokens", () => {
        expect(folderMatchesToken("Archive 2019", ["archive"])).toBe(true);
        expect(folderMatchesToken("Drafts", ["draft"])).toBe(true);
    });
});

describe("folderMatchesToken — Purchase allowlist", () => {
    const tokens = DEFAULT_INCLUDED_FOLDER_NAMES;

    it("matches both naming conventions in the live folder", () => {
        // 2026 uses "Purchase", 2025 uses "Purchase Invoices".
        expect(folderMatchesToken("Purchase", tokens)).toBe(true);
        expect(folderMatchesToken("Purchase Invoices", tokens)).toBe(true);
        expect(folderMatchesToken("Purchases", tokens)).toBe(true);
        expect(folderMatchesToken("purchase invoices", tokens)).toBe(true);
    });

    it("does not put the sales side in scope", () => {
        // The whole point: these must never be treated as expenses.
        expect(folderMatchesToken("Sale", tokens)).toBe(false);
        expect(folderMatchesToken("Sales", tokens)).toBe(false);
        expect(folderMatchesToken("Sale Invoices", tokens)).toBe(false);
        expect(folderMatchesToken("Sales Invoices", tokens)).toBe(false);
    });

    it("does not put the year and month folders in scope by themselves", () => {
        // These are walked to REACH a Purchase folder, but a file sitting
        // loose at this level is out of scope — as with the stray
        // "KA Consultation Agreement Signed.pdf" in the live folder.
        expect(folderMatchesToken("2026", tokens)).toBe(false);
        expect(folderMatchesToken("December 2025", tokens)).toBe(false);
        expect(folderMatchesToken("Tax Invoices & Expenses", tokens)).toBe(false);
    });

    it("leaves the sub-folders below Purchase unmatched (scope is inherited)", () => {
        // These do not need to match — once the walk is inside Purchase,
        // everything under it is in scope regardless of name.
        expect(folderMatchesToken("iTarang Account", tokens)).toBe(false);
        expect(folderMatchesToken("Trontek", tokens)).toBe(false);
        expect(folderMatchesToken("Other Expenses", tokens)).toBe(false);
    });
});

describe("parseDriveFolderId", () => {
    it("reads the id out of a folder URL", () => {
        expect(
            parseDriveFolderId(
                "https://drive.google.com/drive/folders/1X9PwyjeLgpeThaPXI-LP2tBg1ymeBKLi?usp=drive_link",
            ),
        ).toBe("1X9PwyjeLgpeThaPXI-LP2tBg1ymeBKLi");
    });

    it("reads the id out of an open?id= URL", () => {
        expect(
            parseDriveFolderId("https://drive.google.com/open?id=1X9PwyjeLgpeThaPXI"),
        ).toBe("1X9PwyjeLgpeThaPXI");
    });

    it("accepts a bare id", () => {
        expect(parseDriveFolderId("1X9PwyjeLgpeThaPXI-LP2tBg1ymeBKLi")).toBe(
            "1X9PwyjeLgpeThaPXI-LP2tBg1ymeBKLi",
        );
    });

    it("rejects anything that is not an id", () => {
        expect(parseDriveFolderId("")).toBeNull();
        expect(parseDriveFolderId("   ")).toBeNull();
        expect(parseDriveFolderId("not an id")).toBeNull();
        expect(parseDriveFolderId("short")).toBeNull();
    });
});
