import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { isPdf, rasterizePdfFirstPage } from "./pdfToImage";

async function makePdf(): Promise<Buffer> {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([300, 200]);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    page.drawText("ABCDE1234F", { x: 40, y: 100, size: 24, font });
    return Buffer.from(await pdf.save());
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("isPdf", () => {
    it("detects pdf by content-type", () => {
        expect(isPdf("application/pdf", null)).toBe(true);
        expect(isPdf("APPLICATION/PDF; charset=binary", null)).toBe(true);
    });
    it("detects pdf by file name / url extension", () => {
        expect(isPdf(null, "kyc/lead/pan_card_123.pdf")).toBe(true);
        expect(isPdf("image/jpeg", "file.PDF?token=abc")).toBe(true);
    });
    it("returns false for images", () => {
        expect(isPdf("image/jpeg", "photo.jpg")).toBe(false);
        expect(isPdf(null, "photo.png")).toBe(false);
    });
});

describe("rasterizePdfFirstPage", () => {
    it("renders the first page to a PNG buffer", async () => {
        const png = await rasterizePdfFirstPage(await makePdf());
        expect(png.length).toBeGreaterThan(100);
        expect(png.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    });
});
