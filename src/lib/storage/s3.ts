/**
 * Server-only AWS S3 storage backend.
 *
 * Single physical bucket (`AWS_S3_BUCKET`, e.g. itarang-crm-production for prod /
 * itarang-crm-storage for sandbox) holds every object, keyed by the migration
 * layout: a former Supabase bucket `documents` with key `foo/bar.pdf` lives at
 * S3 key `documents/foo/bar.pdf`. So callers keep passing a logical bucket name
 * + key exactly like the Supabase API; `s3Key()` maps it to the physical key.
 *
 * Selection is gated by STORAGE_BACKEND: helpers branch on `isS3Backend` so the
 * app keeps using Supabase until the flag is flipped to "s3" per host. This file
 * never reads/writes anything by itself — it's the backend the storage helpers
 * call when the flag is on.
 */
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import type { StreamingBlobPayloadInputTypes } from "@smithy/types";

export const STORAGE_BACKEND = (process.env.STORAGE_BACKEND).toLowerCase();
export const isS3Backend = STORAGE_BACKEND === "s3";

const REGION = process.env.AWS_REGION;
const S3_BUCKET = process.env.AWS_S3_BUCKET;
// Optional CloudFront (or other CDN) base for formerly-public buckets. With S3
// Block Public Access ON, public S3 URLs do NOT work — set this to a CloudFront
// domain, or callers should use signObject()/a proxy route instead.
const PUBLIC_BASE = (process.env.AWS_S3_PUBLIC_BASE_URL || "").replace(/\/+$/, "");

// E-255 — every successful write is mirrored to Google Drive as a backup.
// Loaded lazily so the googleapis/drizzle graph is not pulled in by callers
// that only need `filesProxyPath()`, and so a mirror problem can never turn
// into an upload failure: the hook is awaited only for its cheap ledger insert
// and swallows everything.
async function notifyStored(input: {
  bucket: string;
  key: string;
  contentType?: string | null;
  size?: number | null;
  body?: Buffer | null;
}): Promise<void> {
  try {
    const m = await import("./drive-mirror");
    await m.onObjectStored(input);
  } catch (err) {
    console.error(
      "[s3] drive-mirror hook failed for",
      `${input.bucket}/${input.key}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

async function notifyRemoved(bucket: string, keys: string[]): Promise<void> {
  try {
    const m = await import("./drive-mirror");
    await m.onObjectsRemoved(bucket, keys);
  } catch {
    /* best-effort */
  }
}

let _client: S3Client | null = null;
function client(): S3Client {
  if (!_client) {
    if (!REGION) throw new Error("s3: AWS_REGION not set");
    _client = new S3Client({
      region: REGION,
      // Explicit keys if present, else fall back to the default provider chain
      // (instance role / shared config) so the VPS can use a role if desired.
      credentials:
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
          ? {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            }
          : undefined,
    });
  }
  return _client;
}

function physicalBucket(): string {
  if (!S3_BUCKET) throw new Error("s3: AWS_S3_BUCKET not set");
  return S3_BUCKET;
}

/** Map a logical (Supabase-style) bucket + key to the physical S3 object key. */
export function s3Key(logicalBucket: string, key: string): string {
  return `${logicalBucket}/${key}`.replace(/\/{2,}/g, "/").replace(/^\/+/, "");
}

/**
 * Relative URL for the authenticated proxy route that serves a formerly-public
 * object (`documents`, `dealer-documents`, `call-recordings`). This is what we
 * store in the DB for new uploads, so <img>/<iframe>/<audio src> resolve to it.
 * Segments are encoded so filenames with parens/spaces are URL-safe.
 */
export function filesProxyPath(logicalBucket: string, key: string): string {
  const enc = key.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  return `/api/files/${logicalBucket}/${enc}`;
}

/** Absolute proxy URL (origin + path) for contexts with no request, e.g. a call
 *  recording link written into an external review sheet. Falls back to the
 *  relative path when NEXT_PUBLIC_APP_URL is unset. */
export function filesProxyUrl(logicalBucket: string, key: string): string {
  const origin = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/+$/, "");
  const p = filesProxyPath(logicalBucket, key);
  return origin ? `${origin}${p}` : p;
}

/**
 * The inverse of filesProxyPath/filesProxyUrl: given a stored URL, say whether
 * it points at our own /api/files proxy and, if so, which object.
 *
 * Exists because a SERVER reading a recording must not go through that route.
 * /api/files/[bucket]/[...path] requires a Supabase session for call-recordings
 * and documents, and a server-side fetch() carries no cookie — so asking our own
 * front door for our own object returns 401. Callers use this to detect the case
 * and read the bytes straight from S3 with getObject().
 *
 * Returns null for anything else (a provider URL, a public bucket URL), which
 * the caller should fetch normally.
 */
export function parseFilesProxyRef(
  urlOrPath: string | null | undefined,
): { bucket: string; key: string } | null {
  if (!urlOrPath) return null;

  let path = urlOrPath;
  if (new RegExp("^https?://", "i").test(urlOrPath)) {
    try {
      path = new URL(urlOrPath).pathname;
    } catch {
      return null;
    }
  }

  const m = new RegExp("^/api/files/([^/]+)/(.+)$").exec(path);
  if (!m) return null;

  // Segments are percent-encoded by filesProxyPath; undo that to recover the
  // real key (which may legitimately contain characters that were escaped).
  const key = m[2]
    .split("/")
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    })
    .join("/");

  return { bucket: decodeURIComponent(m[1]), key };
}

export async function putObject(
  logicalBucket: string,
  key: string,
  body: Buffer,
  contentType = "application/octet-stream",
  opts: { cacheControl?: string } = {},
): Promise<void> {
  await client().send(
    new PutObjectCommand({
      Bucket: physicalBucket(),
      Key: s3Key(logicalBucket, key),
      Body: body,
      ContentType: contentType,
      CacheControl: opts.cacheControl,
    }),
  );
  await notifyStored({ bucket: logicalBucket, key, contentType, size: body.length, body });
}

/**
 * Streaming PUT for uploads that pass through the app server (evidence PDFs
 * and scans posted via the same-origin upload routes — see
 * src/app/api/buyback/uploads and src/app/api/admin/buyback/uploads).
 *
 * `putObject()` above takes a Buffer, which means the caller must first read
 * the whole file into memory (`Buffer.from(await file.arrayBuffer())`). For a
 * 25MB upload on a memory-constrained box, that doubles peak memory per
 * concurrent request for no reason — the bytes are going straight to S3 and
 * never need to exist as one contiguous buffer in this process. `Upload` from
 * @aws-sdk/lib-storage streams the body straight through instead.
 */
export async function putObjectStream(
  logicalBucket: string,
  key: string,
  body: StreamingBlobPayloadInputTypes,
  contentType = "application/octet-stream",
  opts: { cacheControl?: string } = {},
): Promise<void> {
  const upload = new Upload({
    client: client(),
    params: {
      Bucket: physicalBucket(),
      Key: s3Key(logicalBucket, key),
      Body: body,
      ContentType: contentType,
      CacheControl: opts.cacheControl,
    },
  });
  await upload.done();
  // Streamed body is gone by now; the mirror re-reads the object from S3.
  await notifyStored({ bucket: logicalBucket, key, contentType, size: null, body: null });
}

/** Download an object's bytes, or null if it doesn't exist. */
export async function getObject(logicalBucket: string, key: string): Promise<Buffer | null> {
  try {
    const res = await client().send(
      new GetObjectCommand({ Bucket: physicalBucket(), Key: s3Key(logicalBucket, key) }),
    );
    if (!res.Body) return null;
    const bytes = await (res.Body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  } catch (e: unknown) {
    const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) return null;
    throw e;
  }
}

/** A short-lived signed GET URL for direct browser access, or null on failure. */
export async function signObject(
  logicalBucket: string,
  key: string,
  expiresSec = 120,
): Promise<string | null> {
  try {
    return await getSignedUrl(
      client(),
      new GetObjectCommand({ Bucket: physicalBucket(), Key: s3Key(logicalBucket, key) }),
      { expiresIn: expiresSec },
    );
  } catch {
    return null;
  }
}

/**
 * Presigned PUT — lets a browser upload straight to S3, without the bytes ever
 * passing through the Next server.
 *
 * signObject() above only signs GETs; until this was added every upload in the
 * repo POSTed the file through a route into putObject(). That is fine for one
 * PDF, but the buyback intake (M02) uploads 5-6 photos per battery line, which
 * would otherwise stream through the app server on every request.
 *
 * The caller decides the key. The browser must PUT with the SAME Content-Type
 * it was signed for, or S3 rejects the signature.
 */
export async function signUpload(
  logicalBucket: string,
  key: string,
  contentType: string,
  expiresSec = 300,
): Promise<string | null> {
  try {
    return await getSignedUrl(
      client(),
      new PutObjectCommand({
        Bucket: physicalBucket(),
        Key: s3Key(logicalBucket, key),
        ContentType: contentType,
      }),
      { expiresIn: expiresSec },
    );
  } catch (error) {
    // Returning null and staying silent made a signing failure indistinguishable
    // from a missing bucket name — the caller could only say "check the S3
    // configuration", which tells nobody anything. The reason lives here; log it.
    console.error(
      "[s3:signUpload] could not sign a PUT for",
      `${logicalBucket}/${key}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/** Best-effort delete. */
export async function removeObjects(logicalBucket: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await client().send(
    new DeleteObjectsCommand({
      Bucket: physicalBucket(),
      Delete: { Objects: keys.map((k) => ({ Key: s3Key(logicalBucket, k) })), Quiet: true },
    }),
  );
  await notifyRemoved(logicalBucket, keys);
}

/** List object keys under a logical bucket/prefix, returned Supabase-style (no logical-bucket prefix). */
export async function listObjects(logicalBucket: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const fullPrefix = s3Key(logicalBucket, prefix);
  const stripAt = `${logicalBucket}/`;
  let token: string | undefined;
  do {
    const r = await client().send(
      new ListObjectsV2Command({
        Bucket: physicalBucket(),
        Prefix: fullPrefix,
        ContinuationToken: token,
        MaxKeys: 1000,
      }),
    );
    for (const o of r.Contents || []) {
      if (!o.Key) continue;
      out.push(o.Key.startsWith(stripAt) ? o.Key.slice(stripAt.length) : o.Key);
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/**
 * List EVERY object in the physical bucket (optionally under a physical
 * prefix), with sizes. Keys are physical — `<logical bucket>/<key>` — because
 * the caller (the E-255 Drive-mirror backfill) wants to discover the logical
 * buckets rather than be told them.
 */
export async function listAllObjects(
  physicalPrefix = "",
): Promise<Array<{ key: string; size: number | null; lastModified: Date | null }>> {
  const out: Array<{ key: string; size: number | null; lastModified: Date | null }> = [];
  let token: string | undefined;
  do {
    const r = await client().send(
      new ListObjectsV2Command({
        Bucket: physicalBucket(),
        Prefix: physicalPrefix || undefined,
        ContinuationToken: token,
        MaxKeys: 1000,
      }),
    );
    for (const o of r.Contents || []) {
      if (!o.Key || o.Key.endsWith("/")) continue; // skip "folder" placeholder objects
      out.push({ key: o.Key, size: o.Size ?? null, lastModified: o.LastModified ?? null });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/**
 * URL for a formerly-public object. Returns the CloudFront form when
 * AWS_S3_PUBLIC_BASE_URL is set; otherwise the virtual-hosted S3 URL — which
 * only resolves if the object is public (it is NOT under Block Public Access).
 * For private serving, prefer signObject() or an authenticated proxy route.
 */
export function publicUrl(logicalBucket: string, key: string): string {
  const k = s3Key(logicalBucket, key);
  if (PUBLIC_BASE) return `${PUBLIC_BASE}/${k}`;
  return `https://${physicalBucket()}.s3.${REGION}.amazonaws.com/${k}`;
}
