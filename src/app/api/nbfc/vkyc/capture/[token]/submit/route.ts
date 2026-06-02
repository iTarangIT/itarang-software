/**
 * POST /api/nbfc/vkyc/capture/[token]/submit — PUBLIC, token-gated (§11).
 *
 * The customer's recorded live selfie video. Multipart body: `video` (a short
 * webm/mp4 blob recorded in-browser). We score it with Decentro's PASSIVE
 * liveness engine (/v2/kyc/forensics/video_liveness) and flip the track to
 * verified | failed with the liveness verdict + confidence. The token
 * (vkyc_ref) is consumed implicitly: once status leaves 'in_progress',
 * resolveVkycByToken() rejects further use.
 */
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { videoKycAttempts, videoKycVerifications } from "@/lib/db/schema";
import { resolveVkycByToken } from "@/lib/nbfc/vkyc";
import { videoLiveness } from "@/lib/decentro";
import { putNbfcObject } from "@/lib/nbfc/nbfc-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const track = await resolveVkycByToken(token);
  if (!track) {
    return NextResponse.json({ ok: false, error: "This link is invalid, expired, or already used." }, { status: 410 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Expected multipart/form-data body" }, { status: 400 });
  }

  const file = form.get("video");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ ok: false, error: "No video recorded. Please record a short selfie video and retry." }, { status: 422 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ ok: false, error: `The video is too large (max ${MAX_BYTES / (1024 * 1024)} MB). Record a shorter clip.` }, { status: 413 });
  }

  const ext = file.type.includes("mp4") ? "mp4" : "webm";
  const filename = `liveness.${ext}`;
  const now = new Date();

  // Persist the customer's recorded video so the NBFC reviewer can watch it on
  // the Acquire review screen (Addendum V0.3.1 §11.3.4 "Session Video"). We hold
  // the blob in hand (passive flow uploads it to us), unlike the hosted active
  // flow where the video lives on the provider. Stored regardless of pass/fail.
  // Best-effort: a storage hiccup must never block the liveness result.
  let sessionVideoUrl: string | null = null;
  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const { url } = await putNbfcObject(
      `vkyc/${track.id}/liveness-${now.getTime()}.${ext}`,
      buf,
      file.type || (ext === "mp4" ? "video/mp4" : "video/webm"),
    );
    sessionVideoUrl = url;
  } catch (e) {
    console.error("[vkyc submit] video persist failed:", e instanceof Error ? e.message : e);
  }

  // ── Decentro passive liveness ──────────────────────────────────────────────
  let resp: Awaited<ReturnType<typeof videoLiveness>>;
  try {
    resp = await videoLiveness(file, "Customer video liveness for loan KYC", filename);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: `Could not verify the video right now. Please try again. (${e instanceof Error ? e.message : String(e)})` },
      { status: 502 },
    );
  }

  // The API call itself succeeded?
  const apiStatus = String(resp.status ?? resp.responseStatus ?? "").toUpperCase();
  const apiOk = apiStatus === "SUCCESS" || apiStatus === "SUCCESSFUL";
  // The liveness verdict + confidence live on the nested data object.
  const data = (resp.data ?? {}) as { status?: string; confidence?: string | number };
  const livenessRaw = String(data.status ?? "").toUpperCase();
  const isLive = livenessRaw === "SUCCESS" || livenessRaw === "LIVE" || livenessRaw === "PASS" || livenessRaw === "PASSED";
  const confRaw = data.confidence ?? null;
  let confPct: number | null = null;
  if (confRaw != null) {
    const n = Number(confRaw);
    if (Number.isFinite(n)) confPct = n <= 1 ? Math.round(n * 10000) / 100 : Math.round(n * 100) / 100;
  }

  const verified = apiOk && isLive;
  const failureReason = verified
    ? null
    : !apiOk
      ? resp.message || "Liveness check could not be completed."
      : `Liveness not confirmed${livenessRaw ? ` (${livenessRaw.toLowerCase()})` : ""}.`;

  // Update the verification track.
  await db
    .update(videoKycVerifications)
    .set({
      status: verified ? "verified" : "failed",
      liveliness: verified ? "yes" : (livenessRaw ? livenessRaw.slice(0, 16).toLowerCase() : "no"),
      match_score: confPct != null ? confPct.toFixed(2) : null,
      provider_raw_status: apiStatus || null,
      provider_raw_payload: resp as unknown as Record<string, unknown>,
      failure_reason: failureReason,
      ...(sessionVideoUrl ? { session_video_url: sessionVideoUrl } : {}),
      completed_at: now,
      updated_at: now,
    })
    .where(eq(videoKycVerifications.id, track.id));

  // Update the latest attempt row (billing/audit).
  const [attempt] = await db
    .select({ id: videoKycAttempts.id, payload: videoKycAttempts.provider_raw_payload })
    .from(videoKycAttempts)
    .where(eq(videoKycAttempts.verification_id, track.id))
    .orderBy(desc(videoKycAttempts.updated_at))
    .limit(1);
  if (attempt) {
    await db
      .update(videoKycAttempts)
      .set({
        status: verified ? "verified" : "failed",
        provider_raw_status: apiStatus || null,
        provider_raw_payload: { ...(attempt.payload as Record<string, unknown> | null), result: resp, submitted_at: now.toISOString() },
        updated_at: now,
      })
      .where(eq(videoKycAttempts.id, attempt.id));
  }

  return NextResponse.json({ ok: true, status: verified ? "verified" : "failed" });
}
