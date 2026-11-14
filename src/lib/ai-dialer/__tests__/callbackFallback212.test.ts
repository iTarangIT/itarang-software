// ID 212: the missed-callback alert's bell + email fallback to the ISR's manager, while the
// WhatsApp template is not approved, and only when the setting is on.
import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
vi.mock("@/lib/db", () => ({ db: { execute } }));
vi.mock("@/lib/users/team", () => ({ currentTeamOf: async () => new Map([["isr-1", "mgr-1"]]) }));
const emit = vi.fn(async () => {});
vi.mock("@/lib/notifications/emit", () => ({ emit }));
let template: unknown = null;
vi.mock("@/lib/whatsapp/templates", () => ({ resolveTemplate: () => template }));
vi.mock("@/lib/whatsapp", () => ({ getAdapter: () => ({ sendText: async () => ({ ok: true }), sendTemplate: async () => ({ ok: true }) }) }));
vi.mock("@/lib/whatsapp/notifications", () => ({ logOutbound: async () => {} }));
vi.mock("@/lib/whatsapp/window", () => ({ oneLine: (s: string) => s }));

const { alertMissedCallbackWhatsApp } = await import("../callbackMissedAlert");

const cb = { lead_id: "DL-1", name: "Shree Motors", due_at: "2026-11-14T08:30:00Z", assigned_user_id: "isr-1", owner_name: "Nidhi" };

beforeEach(() => {
    vi.clearAllMocks();
    template = null;
    // Sales Heads, then the manager — neither has a WhatsApp number.
    execute.mockResolvedValueOnce([{ user_id: "sh-1", phone: null }]).mockResolvedValueOnce([{ user_id: "mgr-1", phone: null }]);
});

describe("ID 212 fallback", () => {
    it("on: the manager gets a bell + email even with no WhatsApp number anywhere", async () => {
        await alertMissedCallbackWhatsApp(cb, { fallbackBellEmail: true });
        expect(emit).toHaveBeenCalledTimes(1);
        const call = emit.mock.calls[0] as unknown as [{ to: Array<{ audience: { userId: string } }>; email: boolean }];
        expect(call[0].to[0]!.audience.userId).toBe("mgr-1");
        expect(call[0].email).toBe(true);
    });
    it("off (the default): no bell or email from here", async () => {
        await alertMissedCallbackWhatsApp(cb);
        expect(emit).not.toHaveBeenCalled();
    });
    it("once the template is approved: WhatsApp only", async () => {
        template = { name: "itarang_callback_missed", lang: "en" };
        await alertMissedCallbackWhatsApp(cb, { fallbackBellEmail: true });
        expect(emit).not.toHaveBeenCalled();
    });
});
