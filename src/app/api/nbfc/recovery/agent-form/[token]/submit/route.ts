/**
 * E-262 — POST /api/nbfc/recovery/agent-form/[token]/submit — PUBLIC,
 * token-gated. The agent has the battery.
 *
 * Multipart body:
 *   gps_lat, gps_lng, gps_accuracy_m   browser geolocation, REQUIRED
 *   battery_serial                     required when the job carried none
 *   condition_notes, declaration       what they found, and that they took it
 *   photo_serial | photo_battery | photo_vehicle | photo_agent_selfie
 *   photo_extra                        zero or more
 *
 * WHERE THE BYTES GO. Straight into the `documents` bucket as
 * `/api/files/<bucket>/<key>` paths — NOT `/nbfc-uploads/...`. That is not a
 * stylistic choice: `recovery_batteries.image_urls` is contractually that
 * shape, and the auction's WhatsApp fan-out regex-parses it
 * (`/^\/api\/files\/([^/]+)\/(.+)$/`, returning null on anything else). Storing
 * the other form here would send a lot to every dealer with no photograph and
 * no error anywhere to explain it. Approve then attaches these URLs to the
 * battery with no copy step.
 *
 * Each photo is watermarked with the coordinates and the SERVER's timestamp
 * before it is stored. A phone's clock is user-settable and this is evidence.
 */
import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";

import {
  loadLoanContext,
  resolveAssignmentByToken,
  submitRecoveryCollection,
  type SubmittedPhoto,
} from "@/lib/nbfc/recovery/assignment";
import { notifyRecoveryEvent } from "@/lib/notifications/events";
import { watermarkPhoto } from "@/lib/nbfc/fi-watermark";
import { filesProxyPath, isS3Backend, putObjectStream } from "@/lib/storage/s3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "documents";
const MAX_BYTES = 12 * 1024 * 1024; // per photo
const MAX_TOTAL = 60 * 1024 * 1024; // whole request
const NAMED_SLOTS = ["serial", "battery", "vehicle", "agent_selfie"] as const;

function num(v: FormDataEntryValue | null): number | null {
  if (v == null) return null;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const resolved = await resolveAssignmentByToken(token);
  if (resolved.state !== "ok") {
    return NextResponse.json(
      { ok: false, state: resolved.state, error: "This link is no longer usable." },
      { status: 410 },
    );
  }
  const assignment = resolved.assignment;

  // Photographs land in the `documents` bucket, which only exists on the S3
  // backend. Say so plainly rather than writing a path that resolves to
  // nothing — the same 409 the battery photo uploader returns.
  if (!isS3Backend) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Photo storage is not configured on this environment (STORAGE_BACKEND is not s3).",
      },
      { status: 409 },
    );
  }

  // Reject on the declared length BEFORE parsing: formData() buffers the whole
  // body into heap, this form carries several photos, and sandbox and
  // production share one box.
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_TOTAL) {
    return NextResponse.json(
      { ok: false, error: "Those photos are too large. Take fewer, or retry on a better signal." },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Expected multipart/form-data body" },
      { status: 400 },
    );
  }

  if (String(form.get("declaration") ?? "") !== "true") {
    return NextResponse.json(
      { ok: false, error: "Confirm the declaration before submitting." },
      { status: 422 },
    );
  }

  // GPS is a hard block, re-checked server-side. The client asks for it too,
  // but that is UX — this is the rule.
  const gpsLat = num(form.get("gps_lat"));
  const gpsLng = num(form.get("gps_lng"));
  const gpsAcc = num(form.get("gps_accuracy_m"));
  if (gpsLat == null || gpsLng == null) {
    return NextResponse.json(
      { ok: false, error: "Location is required to submit. Enable GPS and try again." },
      { status: 422 },
    );
  }

  const serialFromForm = String(form.get("battery_serial") ?? "").trim();
  if (!assignment.battery_serial && !serialFromForm) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "This job has no battery serial on file. Read it off the casing and enter it before submitting.",
      },
      { status: 422 },
    );
  }

  const collected: Array<{ type: string; file: File }> = [];
  for (const type of NAMED_SLOTS) {
    const f = form.get(`photo_${type}`);
    if (f instanceof File && f.size > 0) collected.push({ type, file: f });
  }
  for (const f of form.getAll("photo_extra")) {
    if (f instanceof File && f.size > 0) collected.push({ type: "extra", file: f });
  }
  if (collected.length === 0) {
    return NextResponse.json(
      { ok: false, error: "At least one photograph is required." },
      { status: 422 },
    );
  }
  for (const c of collected) {
    if (c.file.size > MAX_BYTES) {
      return NextResponse.json(
        { ok: false, error: `${c.type} photo is larger than 12 MB.` },
        { status: 413 },
      );
    }
  }

  const now = new Date();
  const photos: SubmittedPhoto[] = [];
  for (let i = 0; i < collected.length; i++) {
    const { type, file } = collected[i];
    const input = Buffer.from(await file.arrayBuffer());
    // Never throws; reports whether it managed to stamp the image. An unstamped
    // photograph is still evidence — flagged, not dropped.
    const { buffer, applied } = await watermarkPhoto(input, {
      lat: gpsLat,
      lng: gpsLng,
      accuracyM: gpsAcc ?? undefined,
      timestamp: now,
    });

    // Deterministic per (assignment, slot) so the client's auto-retry
    // OVERWRITES rather than piling up a second copy of the same shot.
    // `extra` is indexed so retries stay distinct.
    const key =
      type === "extra"
        ? `recovery/${assignment.id}/extra-${now.getTime()}-${i}.jpg`
        : `recovery/${assignment.id}/${type}.jpg`;

    await putObjectStream(BUCKET, key, Readable.from(buffer), "image/jpeg");
    photos.push({
      photo_type: type,
      image_url: filesProxyPath(BUCKET, key),
      watermark_applied: applied,
    });
  }

  try {
    const updated = await submitRecoveryCollection({
      assignment,
      gps_lat: gpsLat,
      gps_lng: gpsLng,
      gps_accuracy_m: gpsAcc,
      battery_serial: serialFromForm || assignment.battery_serial,
      condition_notes: String(form.get("condition_notes") ?? "").trim() || null,
      photos,
    });
    // Same reason as the visit route: this is how the office finds out. Sent
    // after the commit and swallowed on failure — a battery in a van is not
    // un-collected because an SMTP server was slow.
    try {
      const ctx = await loadLoanContext(assignment.tenant_id, assignment.loan_sanction_id);
      await notifyRecoveryEvent({
        tenantId: assignment.tenant_id,
        nbfcName: ctx?.nbfc_name ?? "Your NBFC",
        event: "collected",
        borrowerName: ctx?.borrower_name ?? "the borrower",
        agentName: assignment.agent_name,
        batterySerial: updated.battery_serial,
        lat: gpsLat,
        lng: gpsLng,
        distanceM:
          updated.distance_from_address_m != null
            ? Number(updated.distance_from_address_m)
            : null,
      });
    } catch {
      /* the collection is recorded either way */
    }

    return NextResponse.json({
      ok: true,
      status: updated.status,
      photos: photos.length,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // The photographs are already stored and the token is still live, so a
    // retry re-uploads over the same keys and re-runs the write. Nothing is
    // lost and nothing is duplicated.
    return NextResponse.json(
      { ok: false, error: msg.replace(/^CONFLICT:\s*/, "") },
      { status: msg.startsWith("CONFLICT") ? 409 : 500 },
    );
  }
}
