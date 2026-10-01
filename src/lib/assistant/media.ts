// Photos, PDFs and location pins a rep sends the assistant (E-311 assistant_media).
//
// A file is stored the moment it arrives (Meta's media URLs expire) and gets a
// short `ref` ("m7k2q9") — the only handle the model ever sees. Every lookup is
// by (user, ref): a rep can never reach another rep's file, whatever the model
// sends. A file is used ONCE: the executor marks it inside the confirming
// transaction, so two cards naming the same photo cannot both write it.
//
// Channel-neutral: the WhatsApp channel downloads and calls storeMediaFile /
// storeLocation; the core tools only read. S3 is imported lazily — s3.ts throws
// at import time without STORAGE_BACKEND, and the tool registry (which reaches
// this module) is loaded by every unit test.

import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { Tx } from "./applierSpec";
import { ActionRejected } from "./applierSpec";

/**
 * The `documents` logical bucket: /api/files serves it only to a signed-in CRM
 * user. NOT `dealer-documents` — that one is served without a session (dealer
 * onboarding uploads anonymously), and these files include PAN cards and GST
 * certificates.
 */
export const MEDIA_BUCKET = "documents";

/** The CRM upload route's own cap and types. */
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const MEDIA_EXT: Readonly<Record<string, string>> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "application/pdf": "pdf",
};

/** How long an unused attachment stays in a rep's context. */
export const PENDING_MEDIA_MINUTES = 15;
/** At most this many pending attachments are offered to the model. */
export const PENDING_MEDIA_MAX = 10;

export type MediaKind = "image" | "document" | "location";

export type MediaRow = {
    id: string;
    ref: string;
    user_id: string;
    kind: MediaKind;
    mime_type: string | null;
    byte_size: number | null;
    file_name: string | null;
    storage_bucket: string | null;
    storage_key: string | null;
    caption: string | null;
    latitude: number | null;
    longitude: number | null;
    place_name: string | null;
    place_address: string | null;
    created_at: Date;
    used_at: Date | null;
};

/** "image/jpeg; charset=…" → "image/jpeg"; "image/jpg" → "image/jpeg". */
export function normalizeMediaMime(mime: string | null | undefined): string | null {
    const base = (mime ?? "").split(";")[0].trim().toLowerCase();
    if (!base) return null;
    return base === "image/jpg" ? "image/jpeg" : base;
}

export function isAcceptedMime(mime: string | null | undefined): boolean {
    const m = normalizeMediaMime(mime);
    return !!m && m in MEDIA_EXT;
}

const REF_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/l/i — read aloud, typed back

/** "m" + 5 unambiguous characters. Unique per user (index + retry). */
export function newMediaRef(bytes: Buffer = randomBytes(5)): string {
    return "m" + [...bytes].map((b) => REF_ALPHABET[b % REF_ALPHABET.length]).join("");
}

/** The /api/files proxy path the CRM already serves (auth'd) — what lead_visits.photos holds. */
export function mediaUrl(bucket: string, key: string): string {
    const enc = key.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
    return `/api/files/${bucket}/${enc}`;
}

function toRow(r: Record<string, unknown>): MediaRow {
    const num = (v: unknown) => (v == null ? null : Number(v));
    return {
        id: String(r.id),
        ref: String(r.ref),
        user_id: String(r.user_id),
        kind: r.kind as MediaKind,
        mime_type: (r.mime_type as string | null) ?? null,
        byte_size: num(r.byte_size),
        file_name: (r.file_name as string | null) ?? null,
        storage_bucket: (r.storage_bucket as string | null) ?? null,
        storage_key: (r.storage_key as string | null) ?? null,
        caption: (r.caption as string | null) ?? null,
        latitude: num(r.latitude),
        longitude: num(r.longitude),
        place_name: (r.place_name as string | null) ?? null,
        place_address: (r.place_address as string | null) ?? null,
        created_at: new Date(r.created_at as string),
        used_at: r.used_at ? new Date(r.used_at as string) : null,
    };
}

const COLS = sql`id::text, ref, user_id::text, kind, mime_type, byte_size, file_name, storage_bucket, storage_key,
                 caption, latitude, longitude, place_name, place_address, created_at, used_at`;

async function insertWithFreshRef(values: (ref: string) => ReturnType<typeof sql>): Promise<MediaRow> {
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            const rows = await db.execute<Record<string, unknown>>(values(newMediaRef()));
            return toRow(rows[0]!);
        } catch (err) {
            const code = (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;
            if (code !== "23505" || attempt === 3) throw err;
        }
    }
    throw new Error("unreachable");
}

/** Store a photo / PDF and record it. The bytes go to S3 first, so a row always has its file. */
export async function storeMediaFile(input: {
    userId: string;
    sourceMessageId: string | null;
    kind: "image" | "document";
    bytes: Buffer;
    mimeType: string;
    fileName: string | null;
    caption: string | null;
    now?: Date;
}): Promise<MediaRow> {
    const mime = normalizeMediaMime(input.mimeType);
    const ext = mime ? MEDIA_EXT[mime] : undefined;
    if (!mime || !ext) throw new Error(`unsupported media type ${input.mimeType}`);
    const s3 = await import("@/lib/storage/s3");
    if (!s3.isS3Backend) throw new Error("media storage needs STORAGE_BACKEND=s3");
    const month = (input.now ?? new Date()).toISOString().slice(0, 7);
    const key = `wa-assistant/${input.userId}/${month}/${randomUUID()}.${ext}`;
    await s3.putObject(MEDIA_BUCKET, key, input.bytes, mime);
    return insertWithFreshRef(
        (ref) => sql`
        INSERT INTO assistant_media
            (ref, user_id, source_message_id, kind, mime_type, byte_size, file_name, storage_bucket, storage_key, caption)
        VALUES (${ref}, ${input.userId}::uuid, ${input.sourceMessageId}::uuid, ${input.kind}, ${mime},
                ${input.bytes.length}, ${input.fileName}, ${MEDIA_BUCKET}, ${key}, ${input.caption})
        RETURNING ${COLS}`,
    );
}

/** Record a location pin (nothing to download: the coordinates are in the message). */
export async function storeLocation(input: {
    userId: string;
    sourceMessageId: string | null;
    latitude: number;
    longitude: number;
    name: string | null;
    address: string | null;
}): Promise<MediaRow> {
    return insertWithFreshRef(
        (ref) => sql`
        INSERT INTO assistant_media
            (ref, user_id, source_message_id, kind, latitude, longitude, place_name, place_address)
        VALUES (${ref}, ${input.userId}::uuid, ${input.sourceMessageId}::uuid, 'location',
                ${input.latitude}, ${input.longitude}, ${input.name}, ${input.address})
        RETURNING ${COLS}`,
    );
}

/** The rep's unused attachments from the last PENDING_MEDIA_MINUTES, oldest first. */
export async function pendingMedia(userId: string): Promise<MediaRow[]> {
    const rows = await db.execute<Record<string, unknown>>(sql`
        SELECT ${COLS} FROM assistant_media
         WHERE user_id = ${userId}::uuid AND used_at IS NULL
           AND created_at > now() - make_interval(mins => ${PENDING_MEDIA_MINUTES})
         ORDER BY created_at DESC
         LIMIT ${PENDING_MEDIA_MAX}
    `);
    return rows.map(toRow).reverse();
}

/** One of THIS user's attachments by ref, or null. Another user's ref is simply not found. */
export async function findMedia(userId: string, ref: string): Promise<MediaRow | null> {
    const clean = ref.trim().toLowerCase();
    if (!/^m[a-z0-9]{3,11}$/.test(clean)) return null;
    const rows = await db.execute<Record<string, unknown>>(sql`
        SELECT ${COLS} FROM assistant_media WHERE user_id = ${userId}::uuid AND ref = ${clean} LIMIT 1
    `);
    return rows[0] ? toRow(rows[0]) : null;
}

/** The stored bytes of a photo / PDF. */
export async function mediaBytes(row: MediaRow): Promise<Buffer | null> {
    if (!row.storage_bucket || !row.storage_key) return null;
    const s3 = await import("@/lib/storage/s3");
    return s3.getObject(row.storage_bucket, row.storage_key);
}

/**
 * Consume attachments inside the confirming transaction. Any one already used
 * (another card confirmed first) rejects the whole action — nothing is written.
 */
export async function consumeMedia(tx: Tx, ids: readonly string[], actionId: string | undefined): Promise<void> {
    if (ids.length === 0) return;
    const unique = [...new Set(ids)];
    const rows = await tx.execute<{ id: string }>(sql`
        UPDATE assistant_media
           SET used_at = now(), used_by_action_id = ${actionId ?? null}::uuid
         WHERE id IN (${sql.join(unique.map((id) => sql`${id}::uuid`), sql`, `)}) AND used_at IS NULL
        RETURNING id
    `);
    if (rows.length !== unique.length) throw new ActionRejected("attachment_used");
}

const TIME = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });

/** One line per attachment, as the model sees it. Coordinates to 5 dp (~1 m). */
export function describeMedia(m: MediaRow): string {
    const at = TIME.format(m.created_at);
    if (m.kind === "location") {
        const place = [m.place_name, m.place_address].filter(Boolean).join(", ");
        return `${m.ref}: location pin ${m.latitude?.toFixed(5)},${m.longitude?.toFixed(5)}${place ? ` "${place}"` : ""} (${at})`;
    }
    const what = m.kind === "image" ? "photo" : m.mime_type === "application/pdf" ? "PDF" : "document";
    const caption = m.caption?.trim() ? ` caption "${m.caption.trim().slice(0, 200)}"` : " no caption";
    const name = m.file_name ? ` file "${m.file_name.slice(0, 80)}"` : "";
    return `${m.ref}: ${what}${name}${caption} (${at})`;
}

/**
 * The context line prepended to the rep's message while attachments are
 * pending. Plain data: the refs are what the tools take.
 */
export function pendingMediaContext(rows: readonly MediaRow[]): string | null {
    if (rows.length === 0) return null;
    return [
        "[Attachments the user sent in the last 15 minutes, not yet used — pass their ids to tools:",
        ...rows.map((r) => `- ${describeMedia(r)}`),
        "]",
    ].join("\n");
}
