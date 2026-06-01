/**
 * Field Investigation helpers — BRD Addendum V0.3.1 §10 (Full Spec).
 *
 * Model C, pure record-only. The FI Coordinator picks an agent from the
 * per-NBFC directory (nbfcFiAgents); iTarang dispatches a single-use link; the
 * AGENT fills a mobile field form at the customer's address (browser GPS +
 * watermarked photos). The Coordinator reviews against auto-flags (§10.8.1) and
 * decides Pass / Fail / Re-inspection. Re-inspection appends a fresh attempt;
 * prior attempts stay in history (is_current=false).
 *
 * One row PER ATTEMPT per (lead × NBFC); `is_current` flags the operative one.
 * 48-hour SLA from agent assignment. Owned by the FI Coordinator (any
 * role-holder may act, §3.5). No per-lead skip (§10.1).
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { fieldInvestigations, fieldInvestigationPhotos } from "@/lib/db/schema";

/** 8 canonical states (§10.4). */
export const FI_STATES = [
  "not_applicable",
  "pending",
  "assigned",
  "in_progress",
  "submitted",
  "passed",
  "failed",
  "re_inspection_requested",
] as const;
export type FiState = (typeof FI_STATES)[number];

/** SLA window from agent assignment (§10.1). */
export const FI_SLA_HOURS = 48;

export function slaDueFrom(assignedAt: Date): Date {
  return new Date(assignedAt.getTime() + FI_SLA_HOURS * 60 * 60 * 1000);
}

export type FiRow = typeof fieldInvestigations.$inferSelect;
export type FiPhoto = typeof fieldInvestigationPhotos.$inferSelect;

/** The operative (current) attempt for (lead × NBFC), or null. */
export async function getCurrentFiTrack(leadId: string, nbfcId: number): Promise<FiRow | null> {
  const rows = await db
    .select()
    .from(fieldInvestigations)
    .where(
      and(
        eq(fieldInvestigations.lead_id, leadId),
        eq(fieldInvestigations.nbfc_id, nbfcId),
        eq(fieldInvestigations.is_current, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Back-compat alias used by the track-gate: returns the current attempt.
 * (Older code imported `getFiTrack`; the current row is the one gates read.)
 */
export const getFiTrack = getCurrentFiTrack;

/** All attempts for (lead × NBFC), newest first (for the "View history" panel). */
export async function getFiHistory(leadId: string, nbfcId: number): Promise<FiRow[]> {
  return db
    .select()
    .from(fieldInvestigations)
    .where(and(eq(fieldInvestigations.lead_id, leadId), eq(fieldInvestigations.nbfc_id, nbfcId)))
    .orderBy(desc(fieldInvestigations.attempt_no));
}

/** Photos for an attempt, in capture order. */
export async function getFiPhotos(fiId: string): Promise<FiPhoto[]> {
  return db
    .select()
    .from(fieldInvestigationPhotos)
    .where(eq(fieldInvestigationPhotos.field_investigation_id, fiId))
    .orderBy(fieldInvestigationPhotos.uploaded_at);
}

/** Single-use link token. Stored on the row; consumed once the form submits. */
export function generateFiLinkToken(): string {
  return randomBytes(24).toString("hex"); // 48 hex chars, fits varchar(80)
}

/**
 * Resolves the live FI attempt for a single-use form-link token: the token must
 * match the current attempt, the link must not have expired, and the visit must
 * not already be submitted/decided. Returns null otherwise.
 */
export async function resolveFiByToken(token: string): Promise<FiRow | null> {
  if (!token) return null;
  const rows = await db
    .select()
    .from(fieldInvestigations)
    .where(and(eq(fieldInvestigations.link_token, token), eq(fieldInvestigations.is_current, true)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.status !== "assigned" && row.status !== "in_progress") return null; // consumed/decided
  if (row.link_expires_at && new Date(row.link_expires_at).getTime() < Date.now()) return null; // expired
  return row;
}

/** Great-circle distance in metres between two lat/long points (haversine). */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000; // earth radius, metres
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export interface FiAutoFlag {
  key: string;
  severity: "red" | "warn";
  label: string;
}

/**
 * Coordinator Review auto-flags (§10.8.1) — surfaced, NEVER auto-fail. A human
 * decides. `agentRefConfigured` is whether the assigned agent has a reference
 * photo on file (for selfie comparison strength).
 */
export function computeFiAutoFlags(row: FiRow, photos: FiPhoto[], agentRefConfigured: boolean): FiAutoFlag[] {
  const flags: FiAutoFlag[] = [];
  const dist = row.distance_from_address_m == null ? null : Number(row.distance_from_address_m);
  const acc = row.gps_accuracy_m == null ? null : Number(row.gps_accuracy_m);

  if (dist != null && dist > 50) {
    flags.push({ key: "gps_distance", severity: "red", label: `GPS ${dist} m from the stated address (> 50 m).` });
  }
  if (acc != null && acc > 100) {
    flags.push({ key: "gps_accuracy", severity: "warn", label: `Low-confidence GPS reading (accuracy ${acc} m > 100 m).` });
  }
  if (row.customer_present === false) {
    flags.push({ key: "customer_absent", severity: "warn", label: "Customer was not present at the visit." });
  }
  if (row.address_match === "partial" || row.address_match === "no") {
    flags.push({ key: "address_match", severity: "red", label: `Address match: ${row.address_match === "no" ? "Does not match" : "Partial"}.` });
  }
  if (row.sla_breached || (row.assigned_at && row.submitted_at && new Date(row.submitted_at).getTime() - new Date(row.assigned_at).getTime() > FI_SLA_HOURS * 3600_000)) {
    flags.push({ key: "sla_breach", severity: "warn", label: "Submitted after the 48-hour SLA." });
  }
  if (photos.some((p) => !p.watermark_applied)) {
    flags.push({ key: "watermark", severity: "warn", label: "One or more photos are missing the GPS/time watermark." });
  }
  if (!agentRefConfigured) {
    flags.push({ key: "no_reference_photo", severity: "warn", label: "Agent reference photo not configured — selfie comparison is weakened." });
  }
  return flags;
}

/**
 * Best-effort geocode of the customer's stated address to a lat/long anchor for
 * the haversine distance flag. Distance is SUPPORTING evidence only (§10.1), so
 * a null result is acceptable — the auto-flag simply notes it can't compute.
 * Uses Google Geocoding when an API key is configured; never throws.
 */
export async function geocodeAddress(address: string | null | undefined): Promise<{ lat: number; lng: number } | null> {
  const key = process.env.GOOGLE_GEOCODING_API_KEY || process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;
  if (!key || !address?.trim()) return null;
  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address.trim())}&region=in&key=${key}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = (await res.json()) as { status?: string; results?: Array<{ geometry?: { location?: { lat: number; lng: number } } }> };
    const loc = j.results?.[0]?.geometry?.location;
    if (j.status !== "OK" || !loc) return null;
    return { lat: loc.lat, lng: loc.lng };
  } catch {
    return null;
  }
}
