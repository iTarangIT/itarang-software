import { describe, expect, it } from "vitest";

import { attachmentName, downloadLogStore, isAttachmentResponse, markDownloadLogged } from "@/lib/exports/downloadContext";

// A39 — every file download is logged once: by the route, or by the wrapper.

describe("download log context", () => {
    it("a route that logs marks the request; outside a request nothing breaks", () => {
        const store = { logged: false };
        downloadLogStore.run(store, () => markDownloadLogged());
        expect(store.logged).toBe(true);
        expect(() => markDownloadLogged()).not.toThrow();
    });

    it("recognises a file response and its name", () => {
        const file = new Response("a,b", {
            headers: { "Content-Type": "text/csv", "Content-Disposition": 'attachment; filename="leads-2026-10-16.csv"' },
        });
        expect(isAttachmentResponse(file)).toBe(true);
        expect(attachmentName(file)).toBe("leads-2026-10-16.csv");
        expect(isAttachmentResponse(new Response("{}", { headers: { "Content-Type": "application/json" } }))).toBe(false);
        expect(isAttachmentResponse(new Response("no", { status: 403, headers: { "Content-Disposition": "attachment" } }))).toBe(false);
    });
});
