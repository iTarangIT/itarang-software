import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { extractSalesInvoiceLines } from "@/lib/ai/invoices/extractSalesInvoiceLines";
import { cleanInvoiceLines } from "@/lib/sales/salesInvoiceLines";
import { batterySerialLines, invoiceSerialTotals } from "@/lib/inventory/stockUploadTasks/rules";

// ID 174 — the line reader returns the serial list per battery row. The model
// is MOCKED (fetch stubbed): tests never call Gemini.
function geminiReply(lines: unknown[]) {
    return {
        ok: true,
        status: 200,
        json: async () => ({
            candidates: [{ content: { parts: [{ text: JSON.stringify({ lines }) }] } }],
        }),
    };
}

describe("extractSalesInvoiceLines serials (ID 174)", () => {
    beforeEach(() => {
        vi.stubEnv("GEMINI_INVOICE_API_KEY", "test-key-not-real");
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it("asks for serial_numbers and returns them per row", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            geminiReply([
                {
                    description: "Li-ion 51.2V 105Ah (FG3WMFG00320)",
                    hsn_code: "85076000",
                    quantity: 2,
                    rate: 30000,
                    amount: 60000,
                    serial_numbers: ["ITB2501", " ITB2502 "],
                },
                { description: "LCD Display with Box", hsn_code: "85079090", quantity: 2, rate: 500, amount: 1000 },
            ]),
        );
        vi.stubGlobal("fetch", fetchMock);

        const out = await extractSalesInvoiceLines(Buffer.from("%PDF-1.4"), "application/pdf", "inv.pdf");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const sent = JSON.parse(String(fetchMock.mock.calls[0][1].body));
        expect(sent.generationConfig.responseSchema.properties.lines.items.properties.serial_numbers.type).toBe("ARRAY");
        expect(out[0].serial_numbers).toEqual(["ITB2501", "ITB2502"]);
        expect(out[1].serial_numbers).toEqual([]);

        const lines = cleanInvoiceLines(out);
        expect(lines[0].serials).toEqual(["ITB2501", "ITB2502"]);
        expect(lines[1].serials).toBeUndefined();
        expect(invoiceSerialTotals(batterySerialLines(lines))).toEqual({ expected: 2, serials: ["ITB2501", "ITB2502"] });
    });
});
