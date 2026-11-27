// "An application already exists for these details" (27 Nov). The person
// filling the onboarding form may LOOK at the application already on file —
// details and documents — but not download anything. Decided 27 Nov (user):
// no code is needed to look; the code is still needed to CHANGE it. Only:
//
//   - through a link that lives 15 minutes;
//   - in the browser the link was made for, and only while it is the latest
//     link that browser was given: each link carries a random nonce, and the
//     browser holds the current nonce in its own httpOnly cookie. A new link
//     replaces the cookie, so the old URL stops working at once — even before
//     its 15 minutes are up. Copied to another browser or phone → refused.
//
// Token: `<applicationId>.<exp>.<nonce>.<hmac>`. Pure, node:crypto only.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { tokenSecret } from "@/lib/onboarding/submitAccess";

export const EXISTING_VIEW_TTL_MS = 15 * 60 * 1000;
export const EXISTING_VIEW_COOKIE = "itg_onboarding_view";
/** How long this browser may keep renewing its own link (each link still lives 15 minutes). */
export const EXISTING_VIEW_COOKIE_MAX_AGE_S = 2 * 60 * 60;
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
    /** Genuine link, but expired / replaced / opened in another browser — a new link is needed. */
    | { ok: false; reason: "expired" | "replaced" | "other_browser"; view: ViewToken }
    | { ok: false; reason: "invalid"; view: null };

/**
 * May this request see the application behind `token`?
 * `cookieNonce` = the latest view link this browser was given (httpOnly cookie).
 */
export function checkViewAccess(input: {
    token: string | null | undefined;
    cookieNonce: string | null | undefined;
    now?: number;
}): ViewAccess {
    const view = readViewToken(input.token);
    if (!view) return { ok: false, reason: "invalid", view: null };
    if (!input.cookieNonce) return { ok: false, reason: "other_browser", view };
    if (input.cookieNonce !== view.nonce) return { ok: false, reason: "replaced", view };
    if (view.exp <= (input.now ?? Date.now())) return { ok: false, reason: "expired", view };
    return { ok: true, view };
}

/** May this browser get a NEW link in place of `token`? Only the browser holding that link's nonce. */
export function canRenewView(token: string | null | undefined, cookieNonce: string | null | undefined): ViewToken | null {
    const view = readViewToken(token);
    return view && !!cookieNonce && cookieNonce === view.nonce ? view : null;
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
        maxAge: EXISTING_VIEW_COOKIE_MAX_AGE_S,
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
