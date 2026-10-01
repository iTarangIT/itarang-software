import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    ecofyApiSigningString,
    signEcofyPayload,
    verifyEcofySignature,
} from "../signature";

const SECRET = "x".repeat(40);
const BODY = JSON.stringify({ eventId: "ecofy:ECOFY:1", type: "lead.pushed", note: "₹ unicode" });
const NOW = 1_790_000_000;

describe("Ecofy signature (docs/ECOFY_INTEGRATION.md §2)", () => {
    it("matches the contract's reference HMAC", () => {
        const expected = createHmac("sha256", SECRET).update(`${NOW}.${BODY}`).digest("hex");
        expect(signEcofyPayload(SECRET, BODY, NOW)).toBe(`t=${NOW},v1=${expected}`);
    });

    it("verifies a string body and the same bytes as a Buffer", () => {
        const header = signEcofyPayload(SECRET, BODY, NOW);
        expect(verifyEcofySignature(SECRET, header, BODY, NOW)).toEqual({ ok: true });
        expect(verifyEcofySignature(SECRET, header, Buffer.from(BODY, "utf8"), NOW)).toEqual({ ok: true });
    });

    it("rejects a tampered body or the wrong secret", () => {
        const header = signEcofyPayload(SECRET, BODY, NOW);
        expect(verifyEcofySignature(SECRET, header, BODY + " ", NOW)).toEqual({ ok: false, reason: "mismatch" });
        expect(verifyEcofySignature("y".repeat(40), header, BODY, NOW)).toEqual({ ok: false, reason: "mismatch" });
    });

    it("rejects timestamps more than 300 s off in either direction", () => {
        expect(verifyEcofySignature(SECRET, signEcofyPayload(SECRET, BODY, NOW - 300), BODY, NOW).ok).toBe(true);
        expect(verifyEcofySignature(SECRET, signEcofyPayload(SECRET, BODY, NOW - 301), BODY, NOW)).toEqual({
            ok: false,
            reason: "stale",
        });
        expect(verifyEcofySignature(SECRET, signEcofyPayload(SECRET, BODY, NOW + 301), BODY, NOW)).toEqual({
            ok: false,
            reason: "stale",
        });
    });

    it("rejects missing or malformed headers", () => {
        expect(verifyEcofySignature(SECRET, null, BODY, NOW)).toEqual({ ok: false, reason: "malformed" });
        expect(verifyEcofySignature(SECRET, `t=${NOW},v1=abc`, BODY, NOW)).toEqual({ ok: false, reason: "malformed" });
        expect(verifyEcofySignature(SECRET, `v1=${"a".repeat(64)},t=${NOW}`, BODY, NOW)).toEqual({
            ok: false,
            reason: "malformed",
        });
    });

    it("builds the §5 signing string", () => {
        expect(ecofyApiSigningString("post", "/api/v1/cases/1/assign", "{}")).toBe(
            "POST\n/api/v1/cases/1/assign\n{}",
        );
        expect(ecofyApiSigningString("GET", "/api/v1/cases?stage=S1", "")).toBe("GET\n/api/v1/cases?stage=S1\n");
    });
});
