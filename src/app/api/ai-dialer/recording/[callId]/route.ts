// GET /api/ai-dialer/recording/[callId]
//
// Self-healing recording link for a placed call. The campaign transcript drawer
// points its <audio> here whenever ai_call_logs.recording_url is still empty —
// which is the NORMAL state for ElevenLabs calls. Unlike Bolna, ElevenLabs never
// hands back a hosted recording URL on its webhook; the audio is only available
// from an authenticated ElevenLabs endpoint, so the browser cannot fetch it
// directly and nothing was ever stored.
//
// On hit:
//   - call already has our copy → 302 to a fresh 15-minute link to it;
//   - call still on Bolna's link → copy it into our storage, repoint the row,
//     then the same (ID 166);
//   - ElevenLabs call with no URL yet → pull the audio, re-host it to the public
//     bucket, BACKFILL ai_call_logs.recording_url so we only do it once, then
//     302 redirect.
//   - otherwise (audio not ready yet / no API key / unknown call) → 404, and the
//     drawer player shows "Recording unavailable".
//
// ID 166 (16 Oct): the redirect target is always our own storage, through a
// fresh 15-minute link signed for the player, after the file rule — never the
// provider's open link (a Bolna call still on one is copied over first).

import { db } from "@/lib/db";
import { aiCallLogs } from "@/lib/db/schema";
import { eq, sql } from "drizzle-orm";
import { isOwnRecordingUrl, ownRecordingUrl, rehostElevenLabsRecording } from "@/lib/ai/storage/recordingStore";
import { FRESH_LINK_TTL_SECONDS, signedFilePath } from "@/lib/storage/fileAccess";
import { canOpenStoredFile } from "@/lib/storage/fileAuthz";
import { filesProxyPath, parseFilesProxyRef } from "@/lib/storage/s3";
import { LEADS_PAGE_ROLES, readsOwnLeadsOnly } from "@/lib/leads/access";
import { getTeamMemberIds } from "@/lib/users/team";
import { ownerScopeIds } from "@/lib/users/teamRules";
import { guardApi } from "@/lib/auth/apiGuard";

function redirectTo(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } });
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ callId: string }> },
) {
  // ID 118: signed in, with a role that reaches this screen.
  const authGate = await guardApi([...LEADS_PAGE_ROLES]);
  if (!authGate.ok) return authGate.response;
  const { callId } = await ctx.params;
  if (!callId) {
    return new Response("callId required", { status: 400 });
  }

  const rows = await db
    .select({
      recordingUrl: aiCallLogs.recording_url,
      provider: aiCallLogs.provider,
      leadId: aiCallLogs.lead_id,
      phoneNumber: aiCallLogs.phone_number,
    })
    .from(aiCallLogs)
    .where(eq(aiCallLogs.call_id, callId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return new Response("Call not found", { status: 404 });
  }

  // ID 45: a rep (asm, inside_sales_rep) plays only calls on leads they own.
  // Owned either by the call's lead_id, or — because webhook finalizers
  // attribute by phone, so lead_id can point elsewhere (see the lead detail
  // page) — by an owned dealer_leads row whose last 10 digits match the call's
  // number. Anything else is "not found", same as no such call.
  if (readsOwnLeadsOnly(authGate.user.role)) {
    const userId = authGate.user.id;
    // ID 155: a manager also plays calls on their direct reports' leads.
    const owners = ownerScopeIds(userId, await getTeamMemberIds(userId));
    const last10 = (row.phoneNumber ?? "").replace(/\D/g, "").slice(-10);
    const owned = (await db.execute<{ ok: boolean }>(sql`
      SELECT TRUE AS ok FROM dealer_leads
       WHERE current_owner_id IN (${sql.join(owners.map((o) => sql`${o}`), sql`, `)})
         AND (
           id = ${row.leadId ?? ""}
           OR (${last10} <> '' AND RIGHT(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ${last10})
         )
       LIMIT 1
    `)) as unknown as Array<{ ok: boolean }>;
    if (owned.length === 0) {
      return new Response("Call not found", { status: 404 });
    }
  }

  // ID 166: only ever OUR copy, through a fresh 15-minute link for this
  // user — never Bolna's open link. A call still on the provider link is
  // copied into our storage now (and the row repointed); the rest of the old
  // ones are copied by scripts/backfill-recordings-rehost.ts.
  let playable = row.recordingUrl ?? "";
  if (playable && !isOwnRecordingUrl(playable)) {
    const copied = await ownRecordingUrl({ provider: row.provider || "bolna", callId, recordingUrl: playable });
    playable = copied && isOwnRecordingUrl(copied) ? copied : "";
    if (!playable) return new Response("Recording not available yet", { status: 404 });
  } else if (!playable && row.provider === "elevenlabs") {
    // ElevenLabs: the audio lives behind an authenticated endpoint (call_id IS
    // the conversation id). Pull + re-host. "" if not ready or no key.
    playable = await rehostElevenLabsRecording(callId);
  }

  if (!playable) {
    return new Response("Recording unavailable", { status: 404 });
  }

  if (playable !== row.recordingUrl) {
    // Lazy backfill so later loads skip the copy.
    try {
      await db
        .update(aiCallLogs)
        .set({ recording_url: playable, updated_at: new Date() })
        .where(eq(aiCallLogs.call_id, callId));
    } catch (err) {
      // Best-effort — the redirect below still works this time.
      console.error("[ai-dialer:recording] backfill failed for", callId, err);
    }
  }

  // The file rule (Admin, Sales Head, CEO, the lead's owner / ASM), then a
  // fresh link signed for this user.
  const ref = parseFilesProxyRef(playable);
  if (!ref) return new Response("Recording unavailable", { status: 404 });
  const { allowed } = await canOpenStoredFile(authGate.user, ref.bucket, ref.key);
  if (!allowed) return new Response("Call not found", { status: 404 });
  const fresh = signedFilePath(filesProxyPath(ref.bucket, ref.key), FRESH_LINK_TTL_SECONDS, { by: authGate.user.id });
  return redirectTo(fresh ?? filesProxyPath(ref.bucket, ref.key));
}
