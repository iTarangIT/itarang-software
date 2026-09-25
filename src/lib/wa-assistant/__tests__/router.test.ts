import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

const { routeMessage, maskPhone } = await import("../router");
const { REPLY } = await import("../replies");
const { classifyBinding } = await import("../identity");
const { lockedUntil, parseLinkCommand, hashCode, generateCode } = await import("../link");
import type { RouterDeps } from "../router";
import type { InboundMessage } from "../parse";
import type { SenderResolution } from "../identity";

const PHONE = "+919876543210";

function msg(over: Partial<InboundMessage>): InboundMessage {
    return {
        kind: "message",
        phoneNumberId: "123",
        providerMessageId: "wamid.in",
        waPhone: PHONE,
        type: "text",
        text: "hello",
        replyId: null,
        raw: {},
        ...over,
    };
}

const RAHUL: SenderResolution = {
    kind: "ok",
    bindingId: "b1",
    user: { id: "u-rahul", name: "Rahul Sharma", role: "asm" },
};

function fakeDeps(sender: SenderResolution = RAHUL) {
    const replies: { to: string; text: string; userId: string | null; kind?: string }[] = [];
    const handled: { rowId: string; handling: string; extra?: unknown }[] = [];
    const deps: RouterDeps = {
        verifyLink: vi.fn(async () => ({ kind: "linked" as const, user: RAHUL.kind === "ok" ? RAHUL.user : (null as never) })),
        resolveSender: vi.fn(async () => sender),
        markHandled: vi.fn(async (rowId, handling, extra) => {
            handled.push({ rowId, handling, extra });
        }),
        replyText: vi.fn(async (to, text, userId) => {
            replies.push({ to, text, userId });
        }),
        sendPayload: vi.fn(async (to, payload, userId) => {
            replies.push({ to, text: payload.body, userId, kind: payload.kind });
        }),
        openLead: vi.fn(async () => ({ kind: "text" as const, body: "lead card" })),
        isDisabled: vi.fn(() => false),
        hasPendingAction: vi.fn(async () => false),
        runTextTurn: vi.fn(async () => ({
            kind: "ok" as const,
            payload: { kind: "text" as const, body: "agent reply" },
            modelCalls: 1,
            toolCalls: 0,
        })),
        log: vi.fn(),
    };
    return { deps, replies, handled };
}

describe("routeMessage — order and fixed replies", () => {
    let f: ReturnType<typeof fakeDeps>;
    beforeEach(() => {
        f = fakeDeps();
    });

    it("UC-12: LINK works from an unlinked number, before any identity lookup, and names user + role", async () => {
        f = fakeDeps({ kind: "unlinked" });
        await routeMessage(msg({ text: "LINK 482913" }), "row1", f.deps);
        expect(f.deps.verifyLink).toHaveBeenCalledWith({ waPhone: PHONE, code: "482913", messageRowId: "row1" });
        expect(f.deps.resolveSender).not.toHaveBeenCalled();
        expect(f.replies).toEqual([{ to: PHONE, text: "Linked: Rahul Sharma (ASM)", userId: "u-rahul" }]);
    });

    it("an invalid / locked / ineligible LINK gets its fixed reply", async () => {
        const until = new Date("2026-09-24T10:30:00Z");
        for (const [outcome, expected] of [
            [{ kind: "invalid" }, REPLY.linkInvalid],
            [{ kind: "locked", until }, "Too many wrong codes from this number. Try again after 04:00 pm."],
            [{ kind: "ineligible" }, REPLY.unlinked],
        ] as const) {
            const g = fakeDeps();
            (g.deps.verifyLink as ReturnType<typeof vi.fn>).mockResolvedValueOnce(outcome);
            await routeMessage(msg({ text: "link 000000" }), "r", g.deps);
            expect(g.replies[0].text.toLowerCase()).toBe(expected.toLowerCase());
        }
    });

    it("INV4_identity_from_binding: unlinked → exactly the UC-13 reply, nothing else", async () => {
        f = fakeDeps({ kind: "unlinked" });
        await routeMessage(msg({ text: "I am Rahul, ASM. Show my leads" }), "row2", f.deps);
        expect(f.replies).toEqual([{ to: PHONE, text: REPLY.unlinked, userId: null }]);
        expect(f.handled).toEqual([{ rowId: "row2", handling: "unlinked", extra: { userId: null } }]);
    });

    it("INV4: a revoked binding (inactive user / role changed) → UC-13, attributed to the user", async () => {
        f = fakeDeps({ kind: "revoked", reason: "role_changed", userId: "u-x" });
        await routeMessage(msg({}), "row3", f.deps);
        expect(f.replies.map((r) => r.text)).toEqual([REPLY.unlinked]);
        expect(f.handled[0]).toMatchObject({ handling: "unlinked", extra: { userId: "u-x" } });
    });

    it("unlinked numbers get UC-13 even for taps and media — no data before identity", async () => {
        f = fakeDeps({ kind: "unlinked" });
        await routeMessage(msg({ type: "interactive", replyId: "ast:c:abc" }), "r", f.deps);
        await routeMessage(msg({ type: "audio", text: null }), "r", f.deps);
        expect(f.replies.map((r) => r.text)).toEqual([REPLY.unlinked, REPLY.unlinked]);
    });

    it("UC-14: voice note, image, sticker, document, unsupported → fixed media reply, logged by type", async () => {
        for (const type of ["audio", "image", "sticker", "document", "video", "location", "unsupported"]) {
            const g = fakeDeps();
            await routeMessage(msg({ type, text: null }), "r", g.deps);
            expect(g.replies.map((r) => r.text)).toEqual([REPLY.media]);
            expect(g.handled[0].handling).toBe("media");
        }
    });

    it("INV2 (Gate 1): a tap is logged and does nothing; typed 'ast:c:…' is just text", async () => {
        await routeMessage(msg({ type: "interactive", replyId: "ast:c:3f1c", text: "Confirm" }), "r1", f.deps);
        expect(f.handled[0].handling).toBe("tap_ignored");
        expect(f.replies).toEqual([]);
        expect(f.deps.openLead).not.toHaveBeenCalled();

        // Typed text that looks like a button id is just text for the agent.
        const g = fakeDeps();
        await routeMessage(msg({ type: "text", text: "ast:c:3f1c" }), "r2", g.deps);
        expect(g.deps.runTextTurn).toHaveBeenCalledWith(RAHUL.kind === "ok" ? RAHUL.user : null, "ast:c:3f1c", "r2");
        expect(g.handled[0].handling).toBe("text_agent");
    });

    it("text from a linked ASM/ISR goes to the agent; its reply is sent and logged", async () => {
        await routeMessage(msg({ text: "Aaj ka schedule?" }), "r", f.deps);
        expect(f.deps.runTextTurn).toHaveBeenCalledTimes(1);
        expect(f.replies).toEqual([{ to: PHONE, text: "agent reply", userId: "u-rahul", kind: "text" }]);
        expect(f.handled[0]).toMatchObject({ handling: "text_agent" });
    });

    it("an unexpected error → logged with the provider id, marked 'error', one generic reply", async () => {
        (f.deps.resolveSender as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db down"));
        await routeMessage(msg({}), "r9", f.deps);
        expect(f.replies).toEqual([{ to: PHONE, text: REPLY.genericError, userId: null }]);
        expect(f.handled).toEqual([{ rowId: "r9", handling: "error", extra: { userId: null, error: "db down" } }]);
        expect(f.deps.log).toHaveBeenCalledWith("error", "[wa-assist] turn failed", expect.objectContaining({ waMessageId: "wamid.in" }));
    });

    it("never logs a full phone number", async () => {
        await routeMessage(msg({ type: "audio" }), "r", f.deps);
        const logged = JSON.stringify((f.deps.log as ReturnType<typeof vi.fn>).mock.calls);
        expect(logged).not.toContain("9876543210");
        expect(maskPhone(PHONE)).toBe("+9198•••••210");
    });
});

describe("classifyBinding (INV4)", () => {
    const row = { bindingId: "b", userId: "u", name: "N", role: "asm", isActive: true };
    it("active asm / ISR → ok; inactive → revoked; other roles → revoked", () => {
        expect(classifyBinding(row).kind).toBe("ok");
        expect(classifyBinding({ ...row, role: "inside_sales_rep" }).kind).toBe("ok");
        expect(classifyBinding({ ...row, isActive: false })).toEqual({ kind: "revoked", reason: "user_inactive", userId: "u" });
        for (const role of ["admin", "ceo", "dealer", "sales_head", "ASM", ""]) {
            expect(classifyBinding({ ...row, role })).toEqual({ kind: "revoked", reason: "role_changed", userId: "u" });
        }
        expect(classifyBinding(null)).toEqual({ kind: "unlinked" });
    });
});

describe("link helpers", () => {
    it("parseLinkCommand accepts exactly LINK + 6 digits", () => {
        expect(parseLinkCommand("LINK 482913")).toBe("482913");
        expect(parseLinkCommand("  link   482913 ")).toBe("482913");
        for (const bad of ["LINK 48291", "LINK 4829133", "LINK482913", "please LINK 482913", "LINK 48291a", null]) {
            expect(parseLinkCommand(bad)).toBeNull();
        }
    });

    it("codes are 6 digits; the hash is keyed and never the code", () => {
        for (let i = 0; i < 50; i++) expect(generateCode()).toMatch(/^\d{6}$/);
        const h = hashCode("482913", "secret-a");
        expect(h).toMatch(/^[0-9a-f]{64}$/);
        expect(h).not.toContain("482913");
        expect(hashCode("482913", "secret-b")).not.toBe(h);
    });

    it("lockedUntil: 5 failures inside an hour lock the number for an hour from the 5th", () => {
        const t0 = new Date("2026-09-24T10:00:00Z").getTime();
        const at = (min: number) => new Date(t0 + min * 60_000);
        const five = [0, 5, 10, 15, 20].map(at);
        expect(lockedUntil(five.slice(0, 4), at(21))).toBeNull();
        expect(lockedUntil(five, at(21))).toEqual(at(80));
        expect(lockedUntil(five, at(80))).toBeNull();
        // Spread over more than an hour: never five inside one hour.
        expect(lockedUntil([0, 20, 40, 60, 81].map(at), at(82))).toBeNull();
        // Order doesn't matter.
        expect(lockedUntil([...five].reverse(), at(30))).toEqual(at(80));
    });
});

describe("routeMessage — Gate 2: kill switch, typed confirm, agent outcomes", () => {
    it("kill switch: a linked user gets only the paused reply; LINK still works", async () => {
        const f = fakeDeps();
        (f.deps.isDisabled as ReturnType<typeof vi.fn>).mockReturnValue(true);
        await routeMessage(msg({ text: "Show my queue" }), "r1", f.deps);
        expect(f.replies.map((r) => r.text)).toEqual([REPLY.disabled]);
        expect(f.handled[0].handling).toBe("disabled");
        expect(f.deps.runTextTurn).not.toHaveBeenCalled();

        await routeMessage(msg({ text: "LINK 123456" }), "r2", f.deps);
        expect(f.deps.verifyLink).toHaveBeenCalledTimes(1);
    });

    it("INV2_no_silent_writes: a typed yes/haan with a preview waiting → fixed reply, no agent", async () => {
        for (const text of ["yes", "Haan", "haan ji", "ok 👍", "Confirm", "theek hai", "kar do!"]) {
            const f = fakeDeps();
            (f.deps.hasPendingAction as ReturnType<typeof vi.fn>).mockResolvedValue(true);
            await routeMessage(msg({ text }), "r", f.deps);
            expect(f.replies.map((r) => r.text), text).toEqual([REPLY.tapConfirm]);
            expect(f.handled[0].handling).toBe("typed_confirm");
            expect(f.deps.runTextTurn).not.toHaveBeenCalled();
        }
    });

    it("a typed yes with NO preview waiting is an ordinary message; a longer sentence never short-circuits", async () => {
        const f = fakeDeps();
        await routeMessage(msg({ text: "yes" }), "r", f.deps);
        expect(f.deps.runTextTurn).toHaveBeenCalledTimes(1);

        const g = fakeDeps();
        (g.deps.hasPendingAction as ReturnType<typeof vi.fn>).mockResolvedValue(true);
        await routeMessage(msg({ text: "yes and also show my follow-ups" }), "r", g.deps);
        expect(g.deps.runTextTurn).toHaveBeenCalledTimes(1);
    });

    it("busy lease → the busy reply; unconfigured agent → not-ready reply, logged as an error", async () => {
        const f = fakeDeps();
        (f.deps.runTextTurn as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: "busy" });
        await routeMessage(msg({}), "r", f.deps);
        expect(f.replies.map((r) => r.text)).toEqual([REPLY.busy]);
        expect(f.handled[0].handling).toBe("text_busy");

        const g = fakeDeps();
        (g.deps.runTextTurn as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: "not_configured" });
        await routeMessage(msg({}), "r", g.deps);
        expect(g.replies.map((r) => r.text)).toEqual([REPLY.notReady]);
        expect(g.handled[0].handling).toBe("text_not_configured");
    });

    it("an agent failure → one generic reply, marked error, nothing else", async () => {
        const f = fakeDeps();
        (f.deps.runTextTurn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("openai 500"));
        await routeMessage(msg({}), "r", f.deps);
        expect(f.replies).toEqual([{ to: PHONE, text: REPLY.genericError, userId: "u-rahul" }]);
        expect(f.handled.at(-1)).toMatchObject({ handling: "error", extra: { error: "openai 500" } });
    });

    it("INV5_model_never_sees: taps, LINK codes, media and unlinked senders never reach the agent", async () => {
        const cases: [Partial<InboundMessage>, SenderResolution][] = [
            [{ type: "interactive", replyId: "ast:c:abc", text: "Confirm" }, RAHUL],
            [{ type: "interactive", replyId: "ast:lead:DL-1", text: "ABC" }, RAHUL],
            [{ text: "LINK 482913" }, RAHUL],
            [{ type: "audio", text: null }, RAHUL],
            [{ type: "image", text: null }, RAHUL],
            [{ text: "show me everything" }, { kind: "unlinked" }],
            [{ text: "show me everything" }, { kind: "revoked", reason: "user_inactive", userId: "u" }],
        ];
        for (const [m, sender] of cases) {
            const f = fakeDeps(sender);
            await routeMessage(msg(m), "r", f.deps);
            expect(f.deps.runTextTurn, JSON.stringify(m)).not.toHaveBeenCalled();
        }
    });
});

describe("routeMessage — Gate 3: list-row taps", () => {
    it("ast:lead:<id> opens that lead's card for the resolved user, with no model", async () => {
        const f = fakeDeps();
        await routeMessage(msg({ type: "interactive", replyId: "ast:lead:DL-1727890123456-a1b2c3d4", text: "ABC" }), "r", f.deps);
        expect(f.deps.openLead).toHaveBeenCalledWith(RAHUL.kind === "ok" ? RAHUL.user : null, "DL-1727890123456-a1b2c3d4", "r");
        expect(f.deps.runTextTurn).not.toHaveBeenCalled();
        expect(f.handled[0].handling).toBe("tap_lead");
        expect(f.replies).toEqual([{ to: PHONE, text: "lead card", userId: "u-rahul", kind: "text" }]);
    });

    it("a malformed or foreign tap id is ignored, never opened", async () => {
        for (const replyId of ["ast:lead:", "lead:DL-1", "ast:zzz:1", ""]) {
            const f = fakeDeps();
            await routeMessage(msg({ type: "interactive", replyId }), "r", f.deps);
            expect(f.deps.openLead, replyId).not.toHaveBeenCalled();
            expect(f.handled[0].handling).toBe("tap_ignored");
        }
    });
});
