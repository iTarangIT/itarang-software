// GET /api/lead-touchpoints/[touchpointId]/recording
//
// The checked play link for a recording kept on a lead touchpoint (NeoDove
// calls, manual calls) — tracker ID 166, 18 Oct item 7. The twin of
// /api/ai-dialer/recording/[callId] for calls that never touch ai_call_logs.
//
// New NeoDove recordings are copied into iTarang storage on arrival
// (src/lib/neodove/inbound.ts), but calls before 13 Oct — and any copy that
// failed — still store NeoDove's open link, which the lead page used to hand
// to the browser as is. Screens now point here instead (recordingLinks.ts
// touchpointRecordingLink). On hit:
//   - the touchpoint still on a provider link → copy it into our storage now
//     and repoint every touchpoint row holding that link;
//   - then the file rule (Admin, Sales Head, CEO, the lead's owner / ASM) and a
//     302 to a fresh 15-minute link signed for this user;
//   - anything else (unknown touchpoint, not yours, copy failed) → 404.

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { isOwnRecordingUrl, ownRecordingUrl } from "@/lib/ai/storage/recordingStore";
import { FRESH_LINK_TTL_SECONDS, signedFilePath } from "@/lib/storage/fileAccess";
import { canOpenStoredFile } from "@/lib/storage/fileAuthz";
import { filesProxyPath, parseFilesProxyRef } from "@/lib/storage/s3";
import { LEADS_PAGE_ROLES, readsOwnLeadsOnly } from "@/lib/leads/access";
import { getTeamMemberIds } from "@/lib/users/team";
import { ownerScopeIds } from "@/lib/users/teamRules";
import { guardApi } from "@/lib/auth/apiGuard";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () => new Response("Recording unavailable", { status: 404 });

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

export async function GET(
    _req: Request,
    ctx: { params: Promise<{ touchpointId: string }> },
) {
    // ID 118: signed in, with a role that reaches the lead page.
    const authGate = await guardApi([...LEADS_PAGE_ROLES]);
    if (!authGate.ok) return authGate.response;
    const { touchpointId } = await ctx.params;
    if (!touchpointId || !UUID.test(touchpointId)) return notFound();

    // recording_url (E-226) read through to_jsonb, like the lead page, so a DB
    // without the column answers "no recording" instead of a 500.
    const [row] = rowsOf<{ dealer_lead_id: string | null; recording_url: string | null; external_system: string | null }>(
        await db.execute(sql`
            SELECT t.dealer_lead_id,
                   to_jsonb(t) ->> 'recording_url' AS recording_url,
                   t.external_system
              FROM lead_touchpoints t
             WHERE t.touchpoint_id = ${touchpointId}::uuid
             LIMIT 1
        `),
    );
    if (!row?.recording_url) return notFound();

    // ID 45 / ID 155: a rep plays only recordings on leads they (or their
    // direct reports) own — same as the AI call player.
    if (readsOwnLeadsOnly(authGate.user.role)) {
        const owners = ownerScopeIds(authGate.user.id, await getTeamMemberIds(authGate.user.id));
        const owned = rowsOf<{ ok: boolean }>(
            await db.execute(sql`
                SELECT TRUE AS ok FROM dealer_leads
                 WHERE id = ${row.dealer_lead_id ?? ""}
                   AND current_owner_id IN (${sql.join(owners.map((o) => sql`${o}`), sql`, `)})
                 LIMIT 1
            `),
        );
        if (owned.length === 0) return notFound();
    }

    // ID 166: only ever OUR copy. A touchpoint still on the provider's link is
    // copied now, under the same key NeoDove's live path uses (<provider>/<touchpoint id>).
    let playable = row.recording_url;
    if (!isOwnRecordingUrl(playable)) {
        const original = playable;
        const copied = await ownRecordingUrl({
            provider: (row.external_system || "neodove").toLowerCase(),
            callId: touchpointId,
            recordingUrl: original,
        });
        if (!copied || !isOwnRecordingUrl(copied)) return notFound();
        playable = copied;
        try {
            await db.execute(sql`
                UPDATE lead_touchpoints SET recording_url = ${playable}
                 WHERE to_jsonb(lead_touchpoints) ->> 'recording_url' = ${original}
            `);
        } catch (err) {
            // Best-effort — this play still works; the next one copies again.
            console.error("[lead-touchpoints:recording] repoint failed for", touchpointId, err);
        }
    }

    const ref = parseFilesProxyRef(playable);
    if (!ref) return notFound();
    const { allowed } = await canOpenStoredFile(authGate.user, ref.bucket, ref.key);
    if (!allowed) return notFound();
    const fresh = signedFilePath(filesProxyPath(ref.bucket, ref.key), FRESH_LINK_TTL_SECONDS, { by: authGate.user.id });
    return new Response(null, { status: 302, headers: { Location: fresh ?? filesProxyPath(ref.bucket, ref.key) } });
}
