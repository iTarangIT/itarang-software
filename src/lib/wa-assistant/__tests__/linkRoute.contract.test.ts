// /api/assistant/link before the Assistant is switched on. The "Link WhatsApp"
// sidebar item ships with the code, but on a host without WA_ASSIST_* — and
// possibly without E-306 — the page must say "not available yet", never 500.
// So nothing may touch the assistant tables until the channel is configured.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth-utils", () => ({
    requireRole: vi.fn(async () => ({ id: "u-1", role: "asm", is_active: true })),
}));
const getLinkState = vi.fn(async () => {
    throw new Error('relation "assistant_wa_bindings" does not exist');
});
const issueLinkCode = vi.fn();
const revokeForUser = vi.fn(async () => 0);
vi.mock("@/lib/wa-assistant/link", () => ({ getLinkState, issueLinkCode, revokeForUser }));

const { GET, POST } = await import("@/app/api/assistant/link/route");

describe("/api/assistant/link on an unconfigured host", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        for (const k of ["WA_ASSIST_PHONE_NUMBER_ID", "WA_ASSIST_ACCESS_TOKEN", "WA_ASSIST_APP_SECRET", "WA_ASSIST_VERIFY_TOKEN"]) delete process.env[k];
    });

    it("GET answers configured:false without reading the (possibly missing) tables", async () => {
        const res = await GET(new Request("https://crm.test/api/assistant/link"));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.data ?? body).toMatchObject({ configured: false, linked: null });
        expect(getLinkState).not.toHaveBeenCalled();
    });

    it("POST refuses with 503 and issues no code", async () => {
        const res = await POST(new Request("https://crm.test/api/assistant/link", { method: "POST" }));
        expect(res.status).toBe(503);
        expect(issueLinkCode).not.toHaveBeenCalled();
    });
});
