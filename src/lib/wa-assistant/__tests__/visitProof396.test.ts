// E-396 — WhatsApp visit proof: the pure parts (rules, parsing, rendering).
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

const { checkShopDistance, checkProofWindow, MAX_SHOP_DISTANCE_M, WA_PROOF_WINDOW_MS } = await import("@/lib/visits/verifiedCapture");
const { parseFlowResponse, parseWebhook } = await import("../parse");
const { proofActionId, provedLines } = await import("../visitProof");
const { renderLocationAsk, renderPhotoAsk, renderTurn, RENDER_LIMITS } = await import("../render");

const ACTION = "11111111-1111-4111-8111-111111111111";

describe("checkShopDistance", () => {
    it("accepts within 100 m and an unknown shop position", () => {
        expect(checkShopDistance(0).ok).toBe(true);
        expect(checkShopDistance(MAX_SHOP_DISTANCE_M).ok).toBe(true);
        expect(checkShopDistance(null).ok).toBe(true);
    });
    it("refuses beyond 100 m and says how far", () => {
        const r = checkShopDistance(101);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.message).toContain("101 m");
        const km = checkShopDistance(3200);
        if (!km.ok) expect(km.message).toContain("3.2 km");
        expect(checkShopDistance(Number.NaN).ok).toBe(false);
    });
});

describe("checkProofWindow", () => {
    const pinAt = new Date("2026-11-24T10:00:00Z");
    it("accepts a photo inside the window", () => {
        expect(checkProofWindow(pinAt, new Date(pinAt.getTime() + 60_000)).ok).toBe(true);
        expect(checkProofWindow(pinAt.toISOString(), new Date(pinAt.getTime() + WA_PROOF_WINDOW_MS)).ok).toBe(true);
    });
    it("refuses a late photo or one before the pin", () => {
        expect(checkProofWindow(pinAt, new Date(pinAt.getTime() + WA_PROOF_WINDOW_MS + 1)).ok).toBe(false);
        expect(checkProofWindow(pinAt, new Date(pinAt.getTime() - 1)).ok).toBe(false);
    });
});

describe("parseFlowResponse", () => {
    it("reads the token and the photo ids", () => {
        const r = parseFlowResponse(
            JSON.stringify({ flow_token: `visit:${ACTION}`, photo: [{ id: "9001", mime_type: "image/jpeg", sha256: "abc", file_name: "x.jpg" }] }),
        );
        expect(r).toEqual({ token: `visit:${ACTION}`, photos: [{ id: "9001", mimeType: "image/jpeg", sha256: "abc" }] });
    });
    it("never throws on junk", () => {
        expect(parseFlowResponse("not json")).toEqual({ token: null, photos: [] });
        expect(parseFlowResponse("null")).toEqual({ token: null, photos: [] });
        expect(parseFlowResponse(JSON.stringify({ photo: [{ nope: 1 }] }))).toEqual({ token: null, photos: [] });
    });
    it("comes through the webhook as flowReply on an interactive message", () => {
        const body = JSON.stringify({
            object: "whatsapp_business_account",
            entry: [
                {
                    changes: [
                        {
                            value: {
                                metadata: { phone_number_id: "123456" },
                                messages: [
                                    {
                                        id: "wamid.1",
                                        from: "919876543210",
                                        type: "interactive",
                                        interactive: {
                                            type: "nfm_reply",
                                            nfm_reply: {
                                                name: "flow",
                                                body: "Sent",
                                                response_json: JSON.stringify({ flow_token: `visit:${ACTION}`, photo: [{ id: "9001", mime_type: "image/jpeg" }] }),
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            ],
        });
        const r = parseWebhook(body);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const m = r.events[0];
        expect(m.kind).toBe("message");
        if (m.kind !== "message") return;
        expect(m.replyId).toBeNull();
        expect(m.flowReply?.token).toBe(`visit:${ACTION}`);
        expect(m.flowReply?.photos[0]?.id).toBe("9001");
    });
});

describe("proofActionId", () => {
    it("accepts only visit:<uuid>", () => {
        expect(proofActionId(`visit:${ACTION}`)).toBe(ACTION);
        expect(proofActionId(ACTION)).toBeNull();
        expect(proofActionId("visit:abc")).toBeNull();
        expect(proofActionId(null)).toBeNull();
    });
});

const PREVIEW = {
    title: "Log visit — Sharma Battery House",
    lines: [
        { label: "Visit", value: "Visited · Interested" },
        { label: "Remarks", value: "met owner" },
        { label: "📍📷 Proof", value: "your location at the shop, then a camera photo" },
    ],
    resets_idle_clock: true,
    warning: null,
    needs_second_confirm: false,
    crm_url: "https://crm.example/leads/DL-1",
};

describe("rendering the proof steps", () => {
    it("a proof preview becomes the Send location ask, not a Confirm card", () => {
        const p = renderTurn({ text: "", results: [{ tool: "log_visit", result: { kind: "preview", action_id: ACTION, preview: PREVIEW, proof: "location" } }] });
        expect(p.kind).toBe("location_request");
        expect(p.body).toContain("Send location");
        expect(p.body).not.toContain("Proof:");
        expect([...p.body].length).toBeLessThanOrEqual(RENDER_LIMITS.previewBody);
    });
    it("an ordinary preview is still the Confirm card", () => {
        const p = renderTurn({ text: "", results: [{ tool: "log_visit", result: { kind: "preview", action_id: ACTION, preview: PREVIEW } }] });
        expect(p.kind).toBe("buttons");
    });
    it("the photo ask opens the Flow bound to the card", () => {
        const p = renderPhotoAsk({ flowId: "777", actionId: ACTION, shop: "Sharma Battery House", distanceLine: "35 m from the shop" });
        expect(p).toMatchObject({ kind: "flow", flowId: "777", token: `visit:${ACTION}`, screen: "SHOP_PHOTO", data: { shop: "Sharma Battery House" } });
        expect(renderLocationAsk(PREVIEW).kind).toBe("location_request");
    });
    it("after the photo the Proof placeholder becomes what was taken", () => {
        const lines = provedLines(PREVIEW.lines, 35);
        expect(lines.some((l) => l.label.includes("Proof"))).toBe(false);
        expect(lines.find((l) => l.label === "📍 Location")?.value).toContain("35 m from the shop");
        expect(lines.find((l) => l.label === "📷 Photo")?.value).toContain("camera photo");
        expect(provedLines(PREVIEW.lines, null).find((l) => l.label === "📍 Location")?.value).toContain("first verified visit");
    });
});
