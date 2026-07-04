/**
 * Server-side reader for document URLs stored in the DB (kyc_documents.file_url,
 * expenses.bill_url, signed_agreement_url, …).
 *
 * Since the S3 migration, new uploads store a RELATIVE files-proxy path
 * (`/api/files/<bucket>/<key>`). Node's fetch() can't parse a relative URL —
 * and even an absolute self-fetch would hit the proxy route's session auth
 * (401) — so server code must read the bytes straight from storage instead of
 * round-tripping through HTTP. Legacy rows hold absolute Supabase storage URLs
 * (public or signed, possibly expired); those are resolved to a bucket + key
 * and read directly too, so expiry no longer matters.
 */
import path from "node:path";

import { supabaseAdmin } from "@/lib/supabase/admin";
import { isS3Backend, getObject } from "@/lib/storage/s3";

/** Failure with a message safe to surface to an admin/dealer as-is. */
export class StoredDocumentError extends Error {}

export interface StoredDocument {
    buffer: Buffer;
    contentType: string;
    filename: string;
}

// Mirrors the files-proxy route's extension map.
const CONTENT_TYPES: Record<string, string> = {
    ".pdf": "application/pdf",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".webm": "video/webm",
    ".mp4": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
    ".csv": "text/csv",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function contentTypeForName(name: string): string {
    const ext = path.extname(name.split("?")[0]).toLowerCase();
    return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function decodeSegment(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

/**
 * Resolve an internal files-proxy path (`/api/files/<bucket>/<key...>`) to a
 * logical bucket + key. Mirrors filesProxyPath() in lib/storage/s3.ts, which
 * URL-encodes each key segment. Tolerates an absolute origin prefix. Returns
 * null for anything that isn't a proxy path.
 */
export function parseFilesProxyPath(
    url: string,
): { bucket: string; key: string } | null {
    const idx = url.indexOf("/api/files/");
    if (idx === -1) return null;
    const rest = url.slice(idx + "/api/files/".length).split("?")[0];
    const segments = rest.split("/").filter(Boolean);
    if (segments.length < 2) return null;
    const [bucket, ...keyParts] = segments;
    const key = keyParts.map(decodeSegment).join("/");
    if (!bucket || !key) return null;
    return { bucket, key };
}

/**
 * Resolve an absolute Supabase storage URL (public, signed — even expired —
 * or authenticated) to a logical bucket + key.
 * Format: …/storage/v1/object/(public|sign|authenticated)/<bucket>/<path>
 */
function parseSupabaseStorageUrl(
    url: string,
): { bucket: string; key: string } | null {
    let pathname: string;
    try {
        pathname = new URL(url).pathname;
    } catch {
        return null;
    }
    const m = pathname.match(
        /\/storage\/v1\/object\/(?:public|sign|authenticated)\/([^/]+)\/(.+)$/,
    );
    if (!m) return null;
    const [, bucket, rawKey] = m;
    const key = rawKey.split("/").map(decodeSegment).join("/");
    if (!bucket || !key) return null;
    return { bucket, key };
}

async function fromSupabase(bucket: string, key: string): Promise<Buffer | null> {
    const { data, error } = await supabaseAdmin.storage.from(bucket).download(key);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
}

/**
 * Read an object's bytes from the active storage backend, falling back to the
 * other backend (migration safety — same semantics as the files-proxy route).
 * Returns null when the object exists in neither.
 */
export async function readBucketObject(
    bucket: string,
    key: string,
): Promise<Buffer | null> {
    let buf: Buffer | null = null;
    try {
        buf = isS3Backend ? await getObject(bucket, key) : await fromSupabase(bucket, key);
        if (!buf) buf = isS3Backend ? await fromSupabase(bucket, key) : await getObject(bucket, key);
    } catch (e) {
        console.error(`[readBucketObject] read failed for ${bucket}/${key}:`, e);
        buf = null;
    }
    return buf;
}

/**
 * Load a stored document's bytes given whatever URL form the DB holds:
 * relative `/api/files/<bucket>/<key>` proxy paths, absolute Supabase storage
 * URLs (public/signed/authenticated, expired ok), or any other absolute
 * http(s) URL (plain fetch with a timeout).
 *
 * Throws StoredDocumentError with a clean, user-safe message on failure —
 * never raw fetch internals like "Failed to parse URL from …".
 */
export async function readStoredDocument(
    fileUrl: string | null | undefined,
): Promise<StoredDocument> {
    if (!fileUrl || typeof fileUrl !== "string") {
        throw new StoredDocumentError("Document has no stored file URL.");
    }

    const located = parseFilesProxyPath(fileUrl) ?? parseSupabaseStorageUrl(fileUrl);
    if (located) {
        const buffer = await readBucketObject(located.bucket, located.key);
        if (!buffer || buffer.byteLength === 0) {
            console.error(
                `[readStoredDocument] object missing in storage: ${located.bucket}/${located.key} (from ${fileUrl})`,
            );
            throw new StoredDocumentError(
                "Document file was not found in storage. Ask the dealer to re-upload it.",
            );
        }
        const filename = located.key.split("/").pop() || "document";
        return { buffer, contentType: contentTypeForName(filename), filename };
    }

    if (!/^https?:\/\//i.test(fileUrl)) {
        console.error(`[readStoredDocument] unrecognized stored file URL: ${fileUrl}`);
        throw new StoredDocumentError(
            "Document file location is not recognized. Ask the dealer to re-upload it.",
        );
    }

    // External absolute URL (e.g. a provider-hosted file) — bounded fetch.
    let res: Response;
    try {
        res = await fetch(fileUrl, {
            cache: "no-store",
            signal: AbortSignal.timeout(20_000),
        });
    } catch (e) {
        console.error(`[readStoredDocument] fetch failed for ${fileUrl}:`, e);
        throw new StoredDocumentError("Could not download the document file.");
    }
    if (!res.ok) {
        throw new StoredDocumentError(
            `Could not download the document file (HTTP ${res.status}).`,
        );
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength === 0) {
        throw new StoredDocumentError("Downloaded document file was empty.");
    }
    const filename = decodeSegment(
        fileUrl.split("?")[0].split("/").pop() || "document",
    );
    const contentType =
        res.headers.get("content-type")?.split(";")[0].trim() ||
        contentTypeForName(filename);
    return { buffer, contentType, filename };
}
