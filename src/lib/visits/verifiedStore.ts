/**
 * Tracker ID 196 — verified visits, the database and storage side. Server only.
 * Rules: ./verifiedCapture.ts. Tables: drizzle/E-363_verified_visits.sql.
 *
 * E-363 is NOT mirrored in schema.ts (Drizzle lists every column in its
 * INSERTs), so everything here is raw SQL behind hasVerifiedVisits(): before
 * the migration visits log exactly as before, unverified.
 */
import { createHash, randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

const BUCKET = "dealer-documents";

let probe: { at: number; ok: boolean } | null = null;

/** Is E-363 on this database? Cached for a minute. */
export async function hasVerifiedVisits(): Promise<boolean> {
    if (probe && Date.now() - probe.at < 60_000) return probe.ok;
    let ok = false;
    try {
        const r = rowsOf<{ ok: boolean }>(
            await db.execute(sql`SELECT to_regclass('public.visit_captures') IS NOT NULL AS ok`),
        );
        ok = Boolean(r[0]?.ok);
    } catch {
        ok = false;
    }
    probe = { at: Date.now(), ok };
    return ok;
}

export class DuplicateVisitPhotoError extends Error {
    constructor() {
        super("This photo is already used on another visit. Take a new photo at the shop.");
    }
}

export type VisitCapture = {
    id: string;
    user_id: string;
    dealer_lead_id: string | null;
    account_id: string | null;
    photo_url: string;
    photo_sha256: string;
    gps_lat: number;
    gps_lng: number;
    gps_accuracy_m: number;
    captured_at: string;
    visit_id: string | null;
};

/** Write the stamped photo to the visit-photos folder; returns the URL to store. */
async function storePhoto(buffer: Buffer): Promise<string> {
    const key = `visit-photos/verified/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.jpg`;
    // Loaded here, not at the top: the storage module throws at import
    // without STORAGE_BACKEND, and recordVisit (which imports this file) is
    // imported by unit tests and scripts that never store anything.
    const { isS3Backend, putObject, filesProxyPath } = await import("@/lib/storage/s3");
    if (isS3Backend) {
        await putObject(BUCKET, key, buffer, "image/jpeg");
        return filesProxyPath(BUCKET, key);
    }
    const { createClient } = await import("@supabase/supabase-js");
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const { error } = await supabase.storage.from(BUCKET).upload(key, buffer, { contentType: "image/jpeg", upsert: false });
    if (error) throw new Error(error.message || "Could not save the photo");
    return supabase.storage.from(BUCKET).getPublicUrl(key).data.publicUrl;
}

/**
 * Save one camera photo for a visit: hash the bytes as they arrived (the
 * same picture twice is refused), stamp location + server time on it, store
 * it, and record the capture. The caller has checked location, photo and who
 * may log for this lead / account.
 */
export async function saveVisitCapture(input: {
    userId: string;
    leadId: string | null;
    accountId: string | null;
    photo: Buffer;
    lat: number;
    lng: number;
    accuracyM: number;
}): Promise<{ id: string; photoUrl: string; capturedAt: string }> {
    const sha = createHash("sha256").update(input.photo).digest("hex");
    const seen = rowsOf<{ x: number }>(
        await db.execute(sql`
            SELECT 1 AS x FROM visit_captures WHERE photo_sha256 = ${sha}
            UNION ALL
            SELECT 1 FROM lead_visits WHERE photo_sha256 = ${sha}
            LIMIT 1
        `),
    );
    if (seen.length > 0) throw new DuplicateVisitPhotoError();

    const now = new Date();
    const { watermarkPhoto } = await import("@/lib/nbfc/fi-watermark");
    const { buffer } = await watermarkPhoto(input.photo, {
        lat: input.lat,
        lng: input.lng,
        accuracyM: input.accuracyM,
        timestamp: now,
        label: "iTarang visit",
    });
    const photoUrl = await storePhoto(buffer);
    try {
        const r = rowsOf<{ id: string; captured_at: string }>(
            await db.execute(sql`
                INSERT INTO visit_captures
                    (user_id, dealer_lead_id, account_id, photo_url, photo_sha256, gps_lat, gps_lng, gps_accuracy_m, captured_at)
                VALUES (${input.userId}, ${input.leadId}, ${input.accountId}, ${photoUrl}, ${sha},
                        ${input.lat}, ${input.lng}, ${input.accuracyM}, ${now.toISOString()})
                RETURNING id::text AS id, captured_at::text AS captured_at
            `),
        );
        return { id: r[0]!.id, photoUrl, capturedAt: r[0]!.captured_at };
    } catch (err) {
        // Two uploads of the same picture racing: the unique index decides.
        if (String((err as { code?: string })?.code) === "23505") throw new DuplicateVisitPhotoError();
        throw err;
    }
}

export async function loadVisitCapture(id: string, tx?: Tx): Promise<VisitCapture | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const r = rowsOf<VisitCapture>(
        await (tx ?? db).execute(sql`
            SELECT id::text AS id, user_id, dealer_lead_id, account_id, photo_url, photo_sha256,
                   gps_lat::float8 AS gps_lat, gps_lng::float8 AS gps_lng, gps_accuracy_m::float8 AS gps_accuracy_m,
                   captured_at, visit_id::text AS visit_id
              FROM visit_captures WHERE id = ${id}::uuid
              ${tx ? sql`FOR UPDATE` : sql``}
        `),
    );
    return r[0] ?? null;
}

/**
 * Mark a lead_visits row as verified by `capture` and the capture as used —
 * in the visit's own transaction, so a failed visit leaves the photo free.
 */
export async function applyCaptureToVisit(tx: Tx, visitId: string, capture: VisitCapture): Promise<void> {
    await tx.execute(sql`
        UPDATE lead_visits
           SET verified = true,
               capture_id = ${capture.id}::uuid,
               photo_sha256 = ${capture.photo_sha256},
               gps_accuracy_m = ${capture.gps_accuracy_m},
               captured_at = ${capture.captured_at}::timestamptz,
               account_id = COALESCE(account_id, ${capture.account_id})
         WHERE visit_id = ${visitId}::uuid
    `);
    await tx.execute(sql`UPDATE visit_captures SET visit_id = ${visitId}::uuid WHERE id = ${capture.id}::uuid`);
}

/** Visit-row fields a capture fills (the GPS + photo the visit stores). */
export function visitFieldsFromCapture(capture: VisitCapture) {
    return {
        photos: [capture.photo_url],
        gps_check_in_lat: capture.gps_lat,
        gps_check_in_lng: capture.gps_lng,
    };
}
