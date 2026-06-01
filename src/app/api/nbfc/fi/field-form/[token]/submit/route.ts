/**
 * POST /api/nbfc/fi/field-form/[token]/submit — PUBLIC, token-gated (§10.7).
 *
 * The FI agent's field-form submission. Multipart body:
 *   gps_lat, gps_lng, gps_accuracy_m   (browser Geolocation at form open)
 *   address_match (matches|partial|no), address_match_notes
 *   customer_present (true|false), customer_present_notes
 *   agent_notes, declaration (true)
 *   photo_<type> files: exterior | customer_at_residence | corroborator |
 *                       agent_selfie ; plus zero-or-more photo_extra
 *
 * Server: hard-block on missing GPS when the NBFC requires it; watermark each
 * photo (lat/long + server timestamp); store under public/nbfc-uploads/fi/{id}/;
 * compute haversine distance from the stated address; flip to `submitted` and
 * consume the token. The Coordinator reviews + decides separately (§10.8).
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { fieldInvestigations, fieldInvestigationPhotos, nbfcServiceConfig } from "@/lib/db/schema";
import { haversineMeters, resolveFiByToken } from "@/lib/nbfc/fi";
import { watermarkPhoto } from "@/lib/nbfc/fi-watermark";
import { putNbfcObject } from "@/lib/nbfc/nbfc-storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 12 * 1024 * 1024; // 12 MB per photo
const KNOWN_TYPES = ["exterior", "customer_at_residence", "corroborator", "agent_selfie"] as const;

function num(v: FormDataEntryValue | null): number | null {
  if (v == null) return null;
  const n = Number(String(v));
  return Number.isFinite(n) ? n : null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const fi = await resolveFiByToken(token);
  if (!fi) {
    return NextResponse.json({ ok: false, error: "This link is invalid, expired, or already used." }, { status: 410 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Expected multipart/form-data body" }, { status: 400 });
  }

  // FI config (required photos + GPS-denied behaviour).
  const [cfg] = await db
    .select({ fiConfig: nbfcServiceConfig.fi_config })
    .from(nbfcServiceConfig)
    .where(eq(nbfcServiceConfig.tenant_id, fi.tenant_id))
    .limit(1);
  const fiConfig = (cfg?.fiConfig as { required_photos?: string[]; gps_denied_block?: boolean } | undefined) ?? {};
  const requiredPhotos = fiConfig.required_photos ?? [...KNOWN_TYPES];
  const gpsBlock = fiConfig.gps_denied_block ?? true;

  const declaration = String(form.get("declaration") ?? "") === "true";
  if (!declaration) {
    return NextResponse.json({ ok: false, error: "The agent declaration must be confirmed." }, { status: 422 });
  }

  const gpsLat = num(form.get("gps_lat"));
  const gpsLng = num(form.get("gps_lng"));
  const gpsAcc = num(form.get("gps_accuracy_m"));
  if (gpsBlock && (gpsLat == null || gpsLng == null)) {
    return NextResponse.json({ ok: false, error: "Location is required to submit. Please enable GPS and retry." }, { status: 422 });
  }

  const addressMatch = String(form.get("address_match") ?? "").trim();
  if (!["matches", "partial", "no"].includes(addressMatch)) {
    return NextResponse.json({ ok: false, error: "address_match must be matches|partial|no" }, { status: 422 });
  }
  const addressMatchNotes = String(form.get("address_match_notes") ?? "").trim() || null;
  if ((addressMatch === "partial" || addressMatch === "no") && !addressMatchNotes) {
    return NextResponse.json({ ok: false, error: "A note is required when the address is a partial / no match." }, { status: 422 });
  }
  const customerPresentRaw = String(form.get("customer_present") ?? "");
  const customerPresent = customerPresentRaw === "true" ? true : customerPresentRaw === "false" ? false : null;
  const customerPresentNotes = String(form.get("customer_present_notes") ?? "").trim() || null;
  if (customerPresent === false && !customerPresentNotes) {
    return NextResponse.json({ ok: false, error: "Describe who confirmed when the customer is not present." }, { status: 422 });
  }
  const agentNotes = String(form.get("agent_notes") ?? "").trim() || null;

  // Collect photos: the four known slots + any number of extras.
  const collected: Array<{ type: string; file: File }> = [];
  for (const type of KNOWN_TYPES) {
    const f = form.get(`photo_${type}`);
    if (f instanceof File && f.size > 0) collected.push({ type, file: f });
  }
  for (const f of form.getAll("photo_extra")) {
    if (f instanceof File && f.size > 0) collected.push({ type: "extra", file: f });
  }

  // Enforce required photo set.
  const presentTypes = new Set(collected.map((c) => c.type));
  const missing = requiredPhotos.filter((t) => !presentTypes.has(t));
  if (missing.length) {
    return NextResponse.json({ ok: false, error: `Missing required photos: ${missing.join(", ")}` }, { status: 422 });
  }
  for (const { file } of collected) {
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ ok: false, error: `A photo exceeds ${MAX_BYTES} bytes` }, { status: 413 });
    }
  }

  const now = new Date();
  const keyDir = `fi/${fi.id}`;

  // Watermark + persist each photo to the private `nbfc-documents` bucket;
  // image_url stays in the `/nbfc-uploads/...` scheme served by the
  // authenticated /api/nbfc-uploads route.
  let i = 0;
  for (const { type, file } of collected) {
    const raw = Buffer.from(await file.arrayBuffer());
    const { buffer, applied } = await watermarkPhoto(raw, { lat: gpsLat, lng: gpsLng, accuracyM: gpsAcc, timestamp: now });
    const filename = `${type}-${now.getTime()}-${i++}.jpg`;
    const { url: imageUrl } = await putNbfcObject(`${keyDir}/${filename}`, buffer, "image/jpeg");
    await db.insert(fieldInvestigationPhotos).values({
      field_investigation_id: fi.id,
      photo_type: type,
      image_url: imageUrl,
      gps_lat: gpsLat != null ? String(gpsLat) : null,
      gps_lng: gpsLng != null ? String(gpsLng) : null,
      gps_server_timestamp: now,
      watermark_applied: applied,
      uploaded_at: now,
    });
  }

  // Distance from the stated address (supporting evidence only, §10.1).
  let distance: string | null = null;
  if (gpsLat != null && gpsLng != null && fi.stated_lat != null && fi.stated_lng != null) {
    distance = String(haversineMeters(Number(fi.stated_lat), Number(fi.stated_lng), gpsLat, gpsLng));
  }
  const slaBreached = !!fi.sla_due_at && now.getTime() > new Date(fi.sla_due_at).getTime();

  await db
    .update(fieldInvestigations)
    .set({
      status: "submitted",
      submitted_at: now,
      visited_at: now,
      gps_lat: gpsLat != null ? String(gpsLat) : null,
      gps_lng: gpsLng != null ? String(gpsLng) : null,
      gps_accuracy_m: gpsAcc != null ? String(gpsAcc) : null,
      gps_server_timestamp: now,
      distance_from_address_m: distance,
      address_match: addressMatch,
      address_match_notes: addressMatchNotes,
      customer_present: customerPresent,
      customer_present_notes: customerPresentNotes,
      agent_notes: agentNotes,
      agent_declaration_at: now,
      sla_breached: slaBreached,
      link_token: null, // consume the single-use link
      updated_at: now,
    })
    .where(eq(fieldInvestigations.id, fi.id));

  return NextResponse.json({ ok: true, status: "submitted" });
}
