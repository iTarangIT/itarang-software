// E-396 — a done visit's proof, taken inside WhatsApp. Deterministic: no model.
//
//   log_visit (visited)   → the card is stored pending with proof.stage
//                           "location" and the chat shows WhatsApp's
//                           "Send location" button (render.renderLocationAsk).
//   location pin arrives  → acceptVisitPin: distance from the shop's known
//                           position (first verified visit there, else a
//                           street-level geocode). Over 100 m → refused, the
//                           ASM sends it again from the shop. Within (or no
//                           position known yet) → stage "photo" and the
//                           camera-only Flow opens (render.renderPhotoAsk).
//   Flow submitted        → acceptVisitPhoto: the photo is downloaded, hashed
//                           (never reused), stamped and saved as a
//                           visit_captures row (source 'whatsapp'), stage
//                           "ready" — and the usual card with Confirm.
//   Confirm               → logVisitApplier writes the visit with the capture
//                           (verified, photo + pin + today's date), as the CRM
//                           capture page does.
//
// The card can be superseded or expire like any other; a pin or photo sent
// with no visit waiting goes the ordinary media way.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { assistantConfig } from "@/lib/assistant/config";
import { redactDeep } from "@/lib/assistant/redact";
import { PENDING_TTL_MINUTES } from "@/lib/assistant/actions";
import { geocodeShop, haversineMeters } from "@/lib/assistant/geo";
import { LogVisitPlan, proofLocationText } from "@/lib/assistant/tools/write/logVisit";
import type { AssistantUser, Preview } from "@/lib/assistant/types";
import {
    checkProofWindow,
    checkShopDistance,
    checkVisitPhoto,
    MAX_VISIT_PHOTO_BYTES,
} from "@/lib/visits/verifiedCapture";
import { DuplicateVisitPhotoError, saveVisitCapture, shopPosition } from "@/lib/visits/verifiedStore";
import { renderPhotoAsk, renderPreview, type WaPayload } from "./render";
import type { InboundMessage } from "./parse";
import type { MediaResult } from "./client";

/** Each proof step gives the ASM this long for the next one. */
export const PROOF_STEP_MINUTES = 15;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ProofRow = { id: string; lead_id: string; plan: LogVisitPlan; preview: Preview };

const text = (body: string): WaPayload => ({ kind: "text", body });

/** "visit:<action uuid>" → the uuid; anything else → null. Pure. */
export function proofActionId(token: string | null | undefined): string | null {
    const m = /^visit:(.+)$/.exec(token ?? "");
    return m && UUID_RE.test(m[1]) ? m[1] : null;
}

/** The card's lines once the proof is in: the "Proof" placeholder becomes what was taken. Pure. */
export function provedLines(lines: Preview["lines"], distanceM: number | null): Preview["lines"] {
    return [
        ...lines.filter((l) => !l.label.includes("Proof")),
        { label: "📍 Location", value: proofLocationText(distanceM) },
        { label: "📷 Photo", value: "camera photo ✓" },
    ];
}

export async function loadProofRow(where: { userId: string; actionId?: string; stages: string[] }): Promise<ProofRow | null> {
    const rows = await db.execute<{ id: string; lead_id: string; input: unknown; preview: unknown }>(sql`
        SELECT id::text AS id, lead_id, input, preview
          FROM assistant_actions
         WHERE user_id = ${where.userId}::uuid
           AND tool = 'log_visit' AND status = 'pending' AND expires_at > now()
           ${where.actionId ? sql`AND id = ${where.actionId}::uuid` : sql``}
           AND input -> 'proof' ->> 'stage' IN (${sql.join(where.stages.map((s) => sql`${s}`), sql`, `)})
         ORDER BY created_at DESC
         LIMIT 1
    `);
    const r = rows[0];
    if (!r) return null;
    const plan = LogVisitPlan.safeParse(r.input);
    if (!plan.success || !plan.data.proof) return null;
    return { id: r.id, lead_id: r.lead_id, plan: plan.data, preview: r.preview as Preview };
}

/** Save the advanced plan; false when the card was confirmed / cancelled / superseded meanwhile. */
async function saveProof(row: ProofRow, plan: LogVisitPlan, preview: Preview, minutes: number): Promise<boolean> {
    const rows = await db.execute<{ id: string }>(sql`
        UPDATE assistant_actions
           SET input = ${JSON.stringify(plan)}::jsonb,
               preview = ${JSON.stringify(redactDeep(preview))}::jsonb,
               expires_at = now() + make_interval(mins => ${minutes}),
               updated_at = now()
         WHERE id = ${row.id}::uuid AND status = 'pending'
        RETURNING id::text AS id
    `);
    return rows.length > 0;
}

async function leadPlace(leadId: string) {
    const [r] = await db.execute<{
        area: string | null;
        city: string | null;
        state: string | null;
        pincode: string | null;
        shop: string | null;
    }>(sql`
        SELECT area, city, state, pincode, COALESCE(NULLIF(shop_name, ''), dealer_name, id) AS shop
          FROM dealer_leads WHERE id = ${leadId}
    `);
    return r ?? null;
}

/**
 * A location pin. Null = no visit is waiting for one (the ordinary media path
 * takes it). Otherwise the reply: refused (too far — send again), or step 2.
 */
export async function acceptVisitPin(
    user: AssistantUser,
    pin: NonNullable<InboundMessage["location"]>,
    now: Date = new Date(),
): Promise<WaPayload | null> {
    // A second pin while the photo is awaited replaces the first.
    const row = await loadProofRow({ userId: user.id, stages: ["location", "photo"] });
    if (!row) return null;
    const flowId = assistantConfig().visitFlowId;
    if (!flowId) return text("Taking the shop photo in WhatsApp is switched off right now. Please log this visit in the CRM.");

    const place = await leadPlace(row.lead_id);
    const shop = place?.shop ?? row.lead_id;
    const pos = await shopPosition(row.lead_id, () =>
        geocodeShop({ area: place?.area, city: place?.city, state: place?.state, pincode: place?.pincode }),
    );
    const meters = pos ? Math.round(haversineMeters(pin.lat, pin.lng, pos.lat, pos.lng)) : null;
    const near = checkShopDistance(meters);
    if (!near.ok) return text(near.message);

    const plan: LogVisitPlan = {
        ...row.plan,
        proof: { stage: "photo", pin: { lat: pin.lat, lng: pin.lng, at: now.toISOString(), distance_m: meters }, capture_id: null },
    };
    if (!(await saveProof(row, plan, row.preview, PROOF_STEP_MINUTES))) {
        return text("That visit card is no longer open. Tell me about the visit again.");
    }
    return renderPhotoAsk({
        flowId,
        actionId: row.id,
        shop,
        distanceLine: meters == null ? "first verified visit here; it becomes the shop's location" : `${meters} m from the shop`,
    });
}

/**
 * The camera Flow's submission → the saved capture and the card with Confirm,
 * or why not. `download` fetches a Meta media id (the Assistant's client).
 */
export async function acceptVisitPhoto(
    user: AssistantUser,
    reply: NonNullable<InboundMessage["flowReply"]>,
    download: (mediaId: string, maxBytes: number) => Promise<MediaResult>,
    now: Date = new Date(),
): Promise<{ payload: WaPayload; actionId: string | null }> {
    const actionId = proofActionId(reply.token);
    if (!actionId) return { payload: text("I couldn't match that form to a visit. Tell me about the visit again."), actionId: null };
    const row = await loadProofRow({ userId: user.id, actionId, stages: ["location", "photo", "ready"] });
    if (!row) {
        return { payload: text("That visit card has expired or was replaced. Tell me about the visit again."), actionId };
    }
    const proof = row.plan.proof!;
    if (proof.stage === "ready") return { payload: renderPreview(row.preview, row.id), actionId };
    if (proof.stage === "location" || !proof.pin) {
        return { payload: text("Send your current location from the shop first (the Send location button), then take the photo."), actionId };
    }
    const fresh = checkProofWindow(proof.pin.at, now);
    if (!fresh.ok) return { payload: text(fresh.message), actionId };

    const photo = reply.photos[0];
    if (!photo) return { payload: text("No photo came through. Tap *Take shop photo* again and take the picture."), actionId };
    const media = await download(photo.id, MAX_VISIT_PHOTO_BYTES);
    if (!media.ok) {
        return {
            payload: text(media.tooLarge ? "That photo is too large (15 MB at most). Take it again." : "I couldn't get the photo from WhatsApp. Tap *Take shop photo* again."),
            actionId,
        };
    }
    const mime = (photo.mimeType ?? media.mimeType ?? "image/jpeg").toLowerCase();
    const pic = checkVisitPhoto({ type: mime, size: media.bytes.length });
    if (!pic.ok) return { payload: text(pic.message), actionId };

    let captureId: string;
    try {
        const saved = await saveVisitCapture({
            userId: user.id,
            leadId: row.lead_id,
            accountId: null,
            photo: media.bytes,
            lat: proof.pin.lat,
            lng: proof.pin.lng,
            accuracyM: null,
            whatsapp: { shopDistanceM: proof.pin.distance_m },
        });
        captureId = saved.id;
    } catch (err) {
        if (err instanceof DuplicateVisitPhotoError) return { payload: text(err.message), actionId };
        throw err;
    }

    const plan: LogVisitPlan = { ...row.plan, proof: { ...proof, stage: "ready", capture_id: captureId } };
    const preview: Preview = { ...row.preview, lines: provedLines(row.preview.lines, proof.pin.distance_m) };
    // The card's footer says "Expires in 10 min": the Confirm step gets exactly that.
    if (!(await saveProof(row, plan, preview, PENDING_TTL_MINUTES))) {
        return { payload: text("That visit card is no longer open. Tell me about the visit again."), actionId };
    }
    return { payload: renderPreview(preview, row.id), actionId };
}
