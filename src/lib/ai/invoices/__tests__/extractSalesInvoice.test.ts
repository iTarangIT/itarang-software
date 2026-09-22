import { beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";

// Capture what the extractor sends to the model instead of calling it.
const create = vi.fn();
vi.mock("@/lib/ai/invoices/client", () => ({
  INVOICE_MODEL: "test-model",
  getOpenAI: () => ({ chat: { completions: { create } } }),
}));

import { extractSalesInvoice } from "@/lib/ai/invoices/extractSalesInvoice";

/** Strips each PDF page is cut into — mirrors PDF_STRIPS in the extractor. */
const STRIPS = 4;

async function makePdf(pages: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < pages; i++) pdf.addPage([300, 200]);
  return Buffer.from(await pdf.save());
}

function sentParts(): Array<{ type: string; image_url?: { url: string } }> {
  const req = create.mock.calls[0][0];
  const user = req.messages.find((m: { role: string }) => m.role === "user");
  return user.content;
}

function systemPrompt(): string {
  const req = create.mock.calls[0][0];
  return req.messages.find((m: { role: string }) => m.role === "system").content;
}

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ total: 100, invoice_date: "2026-08-08" }) } }],
  });
});

describe("extractSalesInvoice — PDF input", () => {
  // The Vyapar invoices are "Microsoft: Print To PDF" output with no text layer.
  // Sent as a raw PDF, the model read almost none of the page and invented the
  // figures: ITG/202627/034 (₹4,35,302, dated 08-08-2026) came back as
  // ₹4,14,770 on one run and ₹4,87,930 on another, both dated 2026-07-02.
  it("sends a PDF as rendered page images, never as a raw file", async () => {
    await extractSalesInvoice(await makePdf(1), "application/pdf", "ITG_202627_034.pdf");

    const parts = sentParts();
    expect(parts.some((p) => p.type === "file")).toBe(false);
    const images = parts.filter((p) => p.type === "image_url");
    // The whole page, plus its enlarged strips.
    expect(images).toHaveLength(1 + STRIPS);
    for (const img of images) {
      expect(img.image_url!.url.startsWith("data:image/png;base64,")).toBe(true);
    }
  });

  it("sends every page, so totals on a second page are not lost", async () => {
    await extractSalesInvoice(await makePdf(2), "application/pdf", "two-pages.pdf");
    expect(sentParts().filter((p) => p.type === "image_url")).toHaveLength(2 * (1 + STRIPS));
  });

  // Small print (the letterhead GSTIN, the taxable-amount table) was misread
  // when the model only had the whole page, which it downscales. Each page also
  // goes in full-resolution strips — and the model is told what they are.
  it("labels the enlarged strips for the model", async () => {
    await extractSalesInvoice(await makePdf(1), "application/pdf", "x.pdf");
    const parts = sentParts() as Array<{ type: string; text?: string }>;
    const label = parts.find((p) => p.type === "text" && /enlarged/i.test(p.text ?? ""));
    expect(label).toBeDefined();
    // Every strip comes after its label.
    const at = parts.indexOf(label!);
    expect(parts.slice(at + 1).filter((p) => p.type === "image_url")).toHaveLength(STRIPS);
  });

  it("fails loudly on a PDF that cannot be rendered rather than guessing", async () => {
    await expect(
      extractSalesInvoice(Buffer.from("not a pdf"), "application/pdf", "broken.pdf"),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});

describe("extractSalesInvoice — prompt", () => {
  // When the model could not read the date it returned the prompt's own worked
  // example ('02-07-2026' → 2026-07-02) — every one of the misread invoices on
  // production carried exactly that date. A concrete date in the prompt is a
  // default answer waiting to be copied.
  it("contains no concrete example date the model could copy", async () => {
    await extractSalesInvoice(await makePdf(1), "application/pdf", "x.pdf");
    const prompt = systemPrompt();
    expect(prompt).not.toMatch(/\b\d{2}-\d{2}-\d{4}\b/);
    expect(prompt).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
  });

  // Vyapar prints 'Total' twice when it rounds: the line-items total (6,24,089.20)
  // and, after 'Round off', the payable total (6,24,089.00). Revenue is the latter.
  it("says which total to take when the invoice rounds", async () => {
    await extractSalesInvoice(await makePdf(1), "application/pdf", "x.pdf");
    expect(systemPrompt()).toMatch(/round off/i);
  });
});
