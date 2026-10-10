// Who may read a stored file through /api/files, and what a file path may look
// like (tracker ID 128).
//
// `dealer-documents` is readable without a login because a dealer uploads to it
// before they have one. Three things were wrong with that:
//   1. the path check refused a plain ".." but not an encoded one, so a crafted
//      link could climb out of the bucket (and, on a storage miss, the reader
//      fell back to the old Supabase storage with the master key);
//   2. the same bucket holds SIGNED AGREEMENTS and audit trails (and buyback
//      evidence), which were therefore open to anyone holding the link;
//   3. the public upload took any folder name it was given.
//
// ID 119 (follow-up): every file, dealer documents included, now needs a login
// or a signed, expiring link. The pre-login onboarding form gets a signed link
// back from its upload (signedFilePath) instead of an open bucket.
//
// This module is the rule for all of it. No storage or env imports besides
// node:crypto, so it can be unit-tested directly.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Decode until it stops changing; a string that is not valid encoding is final. */
function decodings(segment: string): string[] {
    const seen = [segment];
    let cur = segment;
    for (let i = 0; i < 6; i++) {
        let next: string;
        try {
            next = decodeURIComponent(cur);
        } catch {
            break;
        }
        if (next === cur) break;
        seen.push(next);
        cur = next;
    }
    return seen;
}

// eslint-disable-next-line no-control-regex
const UNSAFE = /[\\/\u0000-\u001f\u007f]/;

/**
 * A storage key from URL path segments, or null when any segment — as given or
 * after ANY number of URL-decodings — is `.`, `..`, empty, or carries a slash,
 * backslash or control character. `%2e%2e`, `%252e%252e` and `a%2F..%2Fb` all
 * end here.
 */
export function safeStorageKey(segments: readonly string[] | null | undefined): string | null {
    if (!segments || segments.length === 0) return null;
    for (const segment of segments) {
        if (typeof segment !== "string") return null;
        for (const form of decodings(segment)) {
            const s = form.trim();
            if (s === "" || s === "." || s === ".." || UNSAFE.test(form)) return null;
        }
    }
    return segments.join("/");
}

/**
 * Folders inside `dealer-documents` that are NOT part of the public onboarding
 * flow. Reading them needs a login or a signed link.
 */
export const PRIVATE_DEALER_DOCUMENT_PREFIXES = [
    "agreements",
    "agreement-template-file",
    "dealer-signed-agreement-upload",
    "buyback",
] as const;

const AGREEMENT_FILE = /^(?:signed-agreement|audit-trail|unsigned-agreement)\.pdf$/i;

/** Is this `dealer-documents` key one of the private ones? */
export function isPrivateDealerDocument(key: string): boolean {
    const parts = key.split("/").filter(Boolean);
    const first = (parts[0] ?? "").toLowerCase();
    if ((PRIVATE_DEALER_DOCUMENT_PREFIXES as readonly string[]).includes(first)) return true;
    // Legacy layout: <application id>/signed-agreement.pdf at the bucket root.
    return AGREEMENT_FILE.test(parts[parts.length - 1] ?? "");
}

/**
 * The one folder name the public upload accepts: a single lowercase slug (what
 * the wizard's makeFolderName() produces), never a private folder.
 */
export function publicUploadFolder(raw: string | null | undefined): string | null {
    const folder = (raw ?? "").trim() || "general";
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(folder)) return null;
    if ((PRIVATE_DEALER_DOCUMENT_PREFIXES as readonly string[]).includes(folder)) return null;
    return folder;
}

/** A file name safe to put in a storage key: no path, no control characters. */
export function safeUploadFileName(name: string | null | undefined): string {
    const base = (name ?? "").split(/[\\/]/).pop() ?? "";
    const cleaned = base
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/\s+/g, "-")
        .replace(/[^A-Za-z0-9._()-]/g, "_")
        .replace(/^\.+/, "")
        .slice(-120);
    return cleaned || "file";
}

// ── signed links ────────────────────────────────────────────────────────────
//
// WhatsApp (Meta) fetches a document from the link we give it, with no login.
// For a private file that link carries an expiry and a signature instead.

function linkSecret(): string | null {
    const own = process.env.FILE_LINK_SECRET?.trim();
    if (own) return own;
    // No dedicated secret configured: derive one, so the feature works without
    // a new env var and the master key itself is never used as the HMAC key.
    const master = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    return master ? createHmac("sha256", master).update("file-link-v1").digest("hex") : null;
}

function sign(secret: string, bucket: string, key: string, exp: number): string {
    return createHmac("sha256", secret).update(`${bucket}\n${key}\n${exp}`).digest("hex");
}

/** `exp` and `sig` query values for a link to bucket/key, valid for ttlSeconds. */
export function fileLinkSignature(
    bucket: string,
    key: string,
    ttlSeconds: number,
    now: number = Date.now(),
): { exp: number; sig: string } | null {
    const secret = linkSecret();
    if (!secret) return null;
    const exp = Math.floor(now / 1000) + ttlSeconds;
    return { exp, sig: sign(secret, bucket, key, exp) };
}

export function fileLinkValid(
    bucket: string,
    key: string,
    exp: string | null | undefined,
    sig: string | null | undefined,
    now: number = Date.now(),
): boolean {
    const secret = linkSecret();
    const until = Number(exp);
    if (!secret || !sig || !Number.isInteger(until) || until * 1000 < now) return false;
    const want = Buffer.from(sign(secret, bucket, key, until));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
}

/** bucket + key of a files-proxy URL (relative or absolute), or null. */
function proxyTarget(url: string): { at: number; path: string; bucket: string; key: string } | null {
    const at = url.indexOf("/api/files/");
    if (at === -1) return null;
    const path = url.slice(at).split("?")[0];
    const [bucket, ...rest] = path.slice("/api/files/".length).split("/");
    const key = safeStorageKey(rest.map((s) => {
        try {
            return decodeURIComponent(s);
        } catch {
            return s;
        }
    }));
    return bucket && key ? { at, path, bucket, key } : null;
}

/**
 * The files-proxy path with an expiring signature, for someone with no login
 * who may see this one file: the pre-login dealer onboarding form previewing
 * what it just uploaded, the dealer correction link. Stays relative. Any other
 * URL comes back unchanged. Never store the result — store the plain path.
 */
export function signedFilePath(url: string | null | undefined, ttlSeconds: number): string | null {
    if (!url) return null;
    const t = proxyTarget(url);
    if (!t) return url;
    const signed = fileLinkSignature(t.bucket, t.key, ttlSeconds);
    return signed ? `${t.path}?exp=${signed.exp}&sig=${signed.sig}` : t.path;
}

/**
 * A link an outside service can fetch (WhatsApp/Meta has no login): a
 * files-proxy path becomes an absolute URL with an expiring signature —
 * every stored file needs a login or a signature (ID 119). Anything else is
 * returned made absolute, otherwise unchanged.
 */
export function shareableFileUrl(
    url: string | null | undefined,
    opts: { ttlSeconds?: number; origin?: string } = {},
): string | null {
    if (!url) return null;
    const origin = (opts.origin ?? process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");
    const t = proxyTarget(url);
    if (!t) return url;
    const absolute = /^https?:\/\//i.test(url) ? url.split("?")[0] : `${origin}${t.path}`;
    const signed = fileLinkSignature(t.bucket, t.key, opts.ttlSeconds ?? 60 * 60);
    return signed ? `${absolute}?exp=${signed.exp}&sig=${signed.sig}` : absolute;
}
