// "An application already exists for these details" (27 Nov). After the owner
// mobile code is entered, the dealer may LOOK at the application already on
// file — details and documents — but not download anything, and only:
//
//   - through a link that lives 15 minutes;
//   - in the browser that entered the code (the httpOnly resume cookie from
//     docBinding.ts names the application);
//   - while that link is the latest one this browser was given: each link
//     carries a random nonce, and the browser holds the current nonce in its
//     own httpOnly cookie. A new link replaces the cookie, so the old URL stops
//     working at once — even before its 15 minutes are up.
//
// Token: `<applicationId>.<exp>.<nonce>.<hmac>`. Pure, node:crypto only.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { tokenSecret } from "@/lib/onboarding/submitAccess";

export const EXISTING_VIEW_TTL_MS = 15 * 60 * 1000;
export const EXISTING_VIEW_COOKIE = "itg_onboarding_view";
export const EXISTING_VIEW_PATH = "/onboarding/existing";

// "view." keeps a view token from ever passing as a resume token and back.
const mac = (secret: string, applicationId: string, exp: number, nonce: string) =>
    createHmac("sha256", secret).update(`view.${applicationId}.${exp}.${nonce}`).digest("hex");

export type ViewToken = { applicationId: string; exp: number; nonce: string };

export function signViewToken(
    applicationId: string,
    now: number = Date.now(),
    nonce: string = randomBytes(16).toString("hex"),
): (ViewToken & { token: string }) | null {
    const secret = tokenSecret();
    if (!secret) return null;
    const exp = now + EXISTING_VIEW_TTL_MS;
    return { applicationId, exp, nonce, token: `${applicationId}.${exp}.${nonce}.${mac(secret, applicationId, exp, nonce)}` };
}

/** The token's contents when its signature is genuine — expired or not. Null when forged or malformed. */
export function readViewToken(token: string | null | undefined): ViewToken | null {
    const secret = tokenSecret();
    const parts = (token ?? "").split(".");
    if (!secret || parts.length !== 4) return null;
    const [applicationId, expRaw, nonce, sig] = parts;
    const exp = Number(expRaw);
    if (!applicationId || !nonce || !Number.isInteger(exp)) return null;
    const want = Buffer.from(mac(secret, applicationId, exp, nonce));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got) ? { applicationId, exp, nonce } : null;
}

export type ViewAccess =
    | { ok: true; view: ViewToken }
    /** Genuine link, but expired / replaced / opened in another browser — a new code (or renewal) is needed. */
    | { ok: false; reason: "expired" | "replaced" | "other_browser"; view: ViewToken }
    | { ok: false; reason: "invalid"; view: null };

/**
 * May this request see the application behind `token`?
 * `boundApplication` = the application this browser proved with a code (docBinding.ts);
 * `cookieNonce` = the latest view link this browser was given.
 */
export function checkViewAccess(input: {
    token: string | null | undefined;
    boundApplication: string | null;
    cookieNonce: string | null | undefined;
    now?: number;
}): ViewAccess {
    const view = readViewToken(input.token);
    if (!view) return { ok: false, reason: "invalid", view: null };
    if (view.exp <= (input.now ?? Date.now())) return { ok: false, reason: "expired", view };
    if (input.boundApplication !== view.applicationId) return { ok: false, reason: "other_browser", view };
    if (!input.cookieNonce || input.cookieNonce !== view.nonce) return { ok: false, reason: "replaced", view };
    return { ok: true, view };
}

/** Options for NextResponse.cookies.set(): this browser's current view link. */
export function viewCookie(view: ViewToken) {
    return {
        name: EXISTING_VIEW_COOKIE,
        value: view.nonce,
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax" as const,
        path: "/",
        maxAge: Math.floor(EXISTING_VIEW_TTL_MS / 1000),
    };
}

export function viewPath(token: string): string {
    return `${EXISTING_VIEW_PATH}/${encodeURIComponent(token)}`;
}

/** ••••1234 for the account number on a view-only page. */
export function maskTail(value: string | null | undefined, keep = 4): string | null {
    const v = (value ?? "").replace(/\s+/g, "");
    if (!v) return null;
    return v.length <= keep ? "•".repeat(v.length) : `${"•".repeat(Math.min(v.length - keep, 8))}${v.slice(-keep)}`;
}
