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

import { classifyFile, isKycFile } from "@/lib/storage/fileRules";

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

// `by` (ID 166): the user a fresh in-app link was minted for. It is part of the
// signature, so the open is logged against that person and the value cannot
// be swapped. Links minted for an outside service carry none and sign exactly
// as before, so links already sent keep working.
function sign(secret: string, bucket: string, key: string, exp: number, by?: string | null): string {
    const payload = by ? `${bucket}\n${key}\n${exp}\n${by}` : `${bucket}\n${key}\n${exp}`;
    return createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * ID 166 (10 Oct): "Fresh link on each click, valid 15 minutes. A link pasted
 * into WhatsApp stops working after 15 minutes." Every in-app open mints one
 * of these (GET /api/files/link), and a signed link to a customer KYC file is
 * never honoured for longer than this (fileLinkTooLong).
 */
export const FRESH_LINK_TTL_SECONDS = 15 * 60;
/** Clock skew allowed between the server that signed and the one checking. */
const LINK_SKEW_SECONDS = 60;

/** The logical buckets the /api/files proxy serves. */
export const FILE_PROXY_BUCKETS = ["documents", "dealer-documents", "call-recordings"] as const;

/** `exp` and `sig` query values for a link to bucket/key, valid for ttlSeconds. */
export function fileLinkSignature(
    bucket: string,
    key: string,
    ttlSeconds: number,
    now: number = Date.now(),
    by?: string | null,
): { exp: number; sig: string } | null {
    const secret = linkSecret();
    if (!secret) return null;
    const exp = Math.floor(now / 1000) + ttlSeconds;
    return { exp, sig: sign(secret, bucket, key, exp, by) };
}

export function fileLinkValid(
    bucket: string,
    key: string,
    exp: string | null | undefined,
    sig: string | null | undefined,
    now: number = Date.now(),
    by?: string | null,
): boolean {
    const secret = linkSecret();
    const until = Number(exp);
    if (!secret || !sig || !Number.isInteger(until) || until * 1000 < now) return false;
    const want = Buffer.from(sign(secret, bucket, key, until, by));
    const got = Buffer.from(sig);
    return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * Does this signed link expire further out than `maxSeconds` from now? The
 * expiry is the only time a link carries, so a link minted with a longer life
 * shows up here. For a customer KYC file the files route refuses such a link,
 * which caps every KYC link at 15 minutes whatever minted it.
 */
export function fileLinkTooLong(
    exp: string | number | null | undefined,
    maxSeconds: number = FRESH_LINK_TTL_SECONDS,
    now: number = Date.now(),
): boolean {
    const until = Number(exp);
    if (!Number.isFinite(until)) return true;
    return until * 1000 - now > (maxSeconds + LINK_SKEW_SECONDS) * 1000;
}

/**
 * The life a new link to bucket/key gets: what the caller asked for, but never
 * more than 15 minutes for a customer KYC file (ID 166), whoever signs it.
 */
export function linkTtl(bucket: string, key: string, ttlSeconds: number): number {
    return isKycFile(classifyFile(bucket, key)) ? Math.min(ttlSeconds, FRESH_LINK_TTL_SECONDS) : ttlSeconds;
}

/** bucket + key (and the bare path) of a files-proxy URL, relative or absolute; else null. */
export function filesProxyTarget(url: string): { path: string; bucket: string; key: string } | null {
    const t = proxyTarget(url);
    return t ? { path: t.path, bucket: t.bucket, key: t.key } : null;
}

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
export function signedFilePath(
    url: string | null | undefined,
    ttlSeconds: number,
    opts: { by?: string | null } = {},
): string | null {
    if (!url) return null;
    const t = proxyTarget(url);
    if (!t) return url;
    const signed = fileLinkSignature(t.bucket, t.key, linkTtl(t.bucket, t.key, ttlSeconds), Date.now(), opts.by);
    if (!signed) return t.path;
    const by = opts.by ? `&by=${encodeURIComponent(opts.by)}` : "";
    return `${t.path}?exp=${signed.exp}&sig=${signed.sig}${by}`;
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
    const signed = fileLinkSignature(t.bucket, t.key, linkTtl(t.bucket, t.key, opts.ttlSeconds ?? 60 * 60));
    return signed ? `${absolute}?exp=${signed.exp}&sig=${signed.sig}` : absolute;
}
