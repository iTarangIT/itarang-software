/**
 * View-only page for an application that already exists (27 Nov): 15 minutes,
 * this browser only, and a newer link kills the older one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signResumeToken } from "../submitAccess";
import {
    checkViewAccess,
    EXISTING_VIEW_TTL_MS,
    maskTail,
    readViewToken,
    signViewToken,
} from "../existingView";

beforeEach(() => vi.stubEnv("ONBOARDING_RESUME_SECRET", "test-secret"));
afterEach(() => vi.unstubAllEnvs());

const APP = "11111111-2222-4333-8444-555555555555";
const NOW = 1_800_000_000_000;

describe("view token", () => {
    it("round-trips and lives 15 minutes", () => {
        const v = signViewToken(APP, NOW, "abc")!;
        expect(v.exp - NOW).toBe(EXISTING_VIEW_TTL_MS);
        expect(readViewToken(v.token)).toEqual({ applicationId: APP, exp: v.exp, nonce: "abc" });
    });

    it("rejects tampering and resume tokens", () => {
        const v = signViewToken(APP, NOW, "abc")!;
        expect(readViewToken(v.token.replace(".abc.", ".abd."))).toBeNull();
        expect(readViewToken(v.token.replace(APP, "22222222-2222-4333-8444-555555555555"))).toBeNull();
        expect(readViewToken(signResumeToken(APP, NOW))).toBeNull();
        expect(readViewToken("")).toBeNull();
    });

    it("is null without a secret", () => {
        vi.stubEnv("ONBOARDING_RESUME_SECRET", "");
        vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
        expect(signViewToken(APP, NOW)).toBeNull();
    });
});

describe("checkViewAccess", () => {
    const v = () => signViewToken(APP, NOW, "nonce-1")!;

    it("opens in the bound browser holding the current nonce", () => {
        const r = checkViewAccess({ token: v().token, boundApplication: APP, cookieNonce: "nonce-1", now: NOW + 1000 });
        expect(r.ok).toBe(true);
    });

    it("expires after 15 minutes", () => {
        const r = checkViewAccess({ token: v().token, boundApplication: APP, cookieNonce: "nonce-1", now: NOW + EXISTING_VIEW_TTL_MS });
        expect(r).toMatchObject({ ok: false, reason: "expired" });
    });

    it("refuses another browser (no code entered there)", () => {
        expect(checkViewAccess({ token: v().token, boundApplication: null, cookieNonce: "nonce-1", now: NOW })).toMatchObject({
            ok: false,
            reason: "other_browser",
        });
        expect(
            checkViewAccess({ token: v().token, boundApplication: "other-app", cookieNonce: "nonce-1", now: NOW }),
        ).toMatchObject({ ok: false, reason: "other_browser" });
    });

    it("refuses a link replaced by a newer one", () => {
        expect(checkViewAccess({ token: v().token, boundApplication: APP, cookieNonce: "nonce-2", now: NOW })).toMatchObject({
            ok: false,
            reason: "replaced",
        });
        expect(checkViewAccess({ token: v().token, boundApplication: APP, cookieNonce: null, now: NOW })).toMatchObject({
            ok: false,
            reason: "replaced",
        });
    });

    it("forged → invalid", () => {
        expect(checkViewAccess({ token: "x.y.z.w", boundApplication: APP, cookieNonce: "x", now: NOW })).toEqual({
            ok: false,
            reason: "invalid",
            view: null,
        });
    });
});

describe("maskTail", () => {
    it("keeps the last four", () => {
        expect(maskTail("1234 5678 9012")).toBe("••••••••9012");
        expect(maskTail("12")).toBe("••");
        expect(maskTail(null)).toBeNull();
    });
});
