/**
 * E-263 — POST /api/nbfc/recovery/agent-form/[token]/visit — PUBLIC,
 * token-gated. The agent went and there was no battery to take.
 *
 * The counterpart to /submit, and the more common outcome in practice. Nobody
 * was home, or they were and refused, or the address was wrong. Before this
 * existed the agent's only honest option was to do nothing — which looks
 * exactly like never having left.
 *
 * Multipart, because the locked door is worth photographing. Everything except
 * the GPS and the outcome is optional:
 *   gps_lat, gps_lng, gps_accuracy_m   REQUIRED — this is the proof of the journey
 *   outcome                            not_present | refused | address_not_found |
 *                                      battery_missing | other
 *   notes                              what happened
 *   next_visit_at                      when they will go back; omitted = not going
 *   photo_extra                        zero or more, stored as extras
 *
 * THE TOKEN SURVIVES. The agent is going back on the same job with the same
 * link, so nothing here consumes it — only a completed collection does. If the
 * agreed return falls outside the link's window, the service pushes the window
 * out to cover it.
 */
import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";

import { db } from "@/lib/db";
import { recoveryAssignmentPhotos } from "@/lib/db/schema";
import {
  loadLoanContext,
  recordVisitAttempt,
  resolveAssignmentByToken,
  VISIT_OUTCOME_LABELS,
  VISIT_OUTCOMES,
  type VisitOutcome,
} from "@/lib/nbfc/recovery/assignment";
import { notifyRecoveryEvent } from "@/lib/notifications/events";
import { watermarkPhoto } from "@/lib/nbfc/fi-watermark";
import { filesProxyPath, isS3Backend, putObjectStream } from "@/lib/storage/s3";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUCKET = "documents";
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL = 40 * 1024 * 1024;

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

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_TOTAL) {
    return NextResponse.json(
      { ok: false, error: "Those photos are too large. Take fewer and try again." },
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

  const outcomeRaw = String(form.get("outcome") ?? "").trim();
  if (!(VISIT_OUTCOMES as readonly string[]).includes(outcomeRaw)) {
    return NextResponse.json(
      { ok: false, error: `outcome must be one of: ${VISIT_OUTCOMES.join(", ")}` },
      { status: 422 },
    );
  }
  const outcome = outcomeRaw as VisitOutcome;

  // Same hard block as a collection. The location IS the report: without it,
  // this is a claim rather than a record.
  const gpsLat = num(form.get("gps_lat"));
  const gpsLng = num(form.get("gps_lng"));
  const gpsAcc = num(form.get("gps_accuracy_m"));
  if (gpsLat == null || gpsLng == null) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Location is required — it is what shows the office you attended. Enable GPS and try again.",
      },
      { status: 422 },
    );
  }

  const notes = String(form.get("notes") ?? "").trim() || null;
  if (outcome === "other" && !notes) {
    return NextResponse.json(
      { ok: false, error: "Describe what happened when the reason is 'Other'." },
      { status: 422 },
    );
  }

  const nextRaw = String(form.get("next_visit_at") ?? "").trim();
  let nextVisit: Date | null = null;
  if (nextRaw) {
    const d = new Date(nextRaw);
    if (Number.isNaN(d.getTime())) {
      return NextResponse.json(
        { ok: false, error: "That return date could not be read." },
        { status: 422 },
      );
    }
    // A return visit in the past is a typo, and a silently accepted one would
    // sit in the NBFC's overdue view for ever.
    if (d.getTime() < Date.now() - 60 * 60 * 1000) {
      return NextResponse.json(
        { ok: false, error: "The return visit cannot be in the past." },
        { status: 422 },
      );
    }
    nextVisit = d;
  }

  const now = new Date();

  try {
    const result = await recordVisitAttempt({
      assignment,
      outcome,
      gps_lat: gpsLat,
      gps_lng: gpsLng,
      gps_accuracy_m: gpsAcc,
      notes,
      next_visit_at: nextVisit,
    });

    // Photographs are optional here, and stored as `extra` so they never
    // occupy one of the collection's named slots — a picture of a locked door
    // is not the battery.
    if (isS3Backend) {
      const files = form
        .getAll("photo_extra")
        .filter((f): f is File => f instanceof File && f.size > 0 && f.size <= MAX_BYTES);
      for (let i = 0; i < files.length; i++) {
        const input = Buffer.from(await files[i].arrayBuffer());
        const { buffer, applied } = await watermarkPhoto(input, {
          lat: gpsLat,
          lng: gpsLng,
          accuracyM: gpsAcc ?? undefined,
          timestamp: now,
        });
        const key = `recovery/${assignment.id}/visit-${result.attempt.attempt_no}-${i}.jpg`;
        await putObjectStream(BUCKET, key, Readable.from(buffer), "image/jpeg");
        await db.insert(recoveryAssignmentPhotos).values({
          assignment_id: assignment.id,
          photo_type: "extra",
          image_url: filesProxyPath(BUCKET, key),
          gps_lat: String(gpsLat),
          gps_lng: String(gpsLng),
          gps_server_timestamp: now,
          watermark_applied: applied,
          uploaded_at: now,
        });
      }
    }

    // The agent has no way into the portal, so this notification IS how the
    // office learns they attended — and it carries the coordinates, because a
    // report saying "nobody home" is a claim and the same report with a map pin
    // at the borrower's address is a record. Best-effort: a failed send must
    // never lose the visit that has already been committed.
    try {
      const ctx = await loadLoanContext(assignment.tenant_id, assignment.loan_sanction_id);
      await notifyRecoveryEvent({
        tenantId: assignment.tenant_id,
        nbfcName: ctx?.nbfc_name ?? "Your NBFC",
        event: "visit",
        borrowerName: ctx?.borrower_name ?? "the borrower",
        agentName: assignment.agent_name,
        batterySerial: assignment.battery_serial,
        lat: gpsLat,
        lng: gpsLng,
        distanceM:
          result.attempt.distance_from_address_m != null
            ? Number(result.attempt.distance_from_address_m)
            : null,
        outcomeLabel: VISIT_OUTCOME_LABELS[outcome],
        nextVisitAt: nextVisit,
        notes,
      });
    } catch {
      /* the visit is recorded either way */
    }

    return NextResponse.json({
      ok: true,
      attempt_no: result.attempt.attempt_no,
      next_visit_at: result.attempt.next_visit_at,
      link_extended: result.link_extended,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg.replace(/^CONFLICT:\s*/, "") },
      { status: msg.startsWith("CONFLICT") ? 409 : 500 },
    );
  }
}
