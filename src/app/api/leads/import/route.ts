// The /leads "Import" modal's commit endpoint.
//
// SECURITY (E-224). This route previously had NO auth check of any kind — an
// unauthenticated POST could insert straight into dealer_leads. It now requires
// one of the lead-management roles, matching the Bulk Lead Upload wizard.
//
// DEDUPE (E-224). It also used to carry its own lax phone normaliser and a
// phone-match-means-skip rule, so the same sheet classified differently here
// than through the bulk wizard: a Lost dealer was silently dropped instead of
// reactivated, and a dealer who had moved city was silently dropped instead of
// raising a merge request. Both paths now share src/lib/leads/dedupe.ts, so the
// only remaining difference between this route and the wizard is the richer
// column set and the rollback batch the wizard records.
//
// PERFORMANCE. The old loop ran one SELECT per row. On the 5000-row sheets this
// modal accepts that is 5000 round-trips; the request timed out long before the
// inserts finished. Now: one batched lookup, then a tight in-memory classify.

import { NextResponse } from "next/server";
import crypto from "crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerLeads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { withErrorHandler, errorResponse } from "@/lib/api-utils";
import {
  classifyAgainstExisting,
  loadExistingByPhone,
  normalizePhone,
} from "@/lib/leads/dedupe";
import { reactivateLead } from "@/lib/leads/reactivation";
import {
  normalizeCity,
  normalizeState,
  inferStateFromCity,
} from "@/lib/scraper-enrichment";

// Same ceiling the bulk wizard enforces (MAX_UPLOAD_ROWS). Without it this
// route will happily accept an unbounded JSON array.
const MAX_IMPORT_ROWS = 5000;

// Mirrors the Bulk Lead Upload page's role gate (admin/upload + inside-sales/upload).
const IMPORT_ROLES = [
  "admin",
  "sales_head",
  "business_head",
  "ceo",
  "sales_manager",
  "inside_sales_rep",
];

type IncomingLead = {
  phone?: unknown;
  dealer_name?: unknown;
  shop_name?: unknown;
  location?: unknown;
  state?: unknown;
  city?: unknown;
  area?: unknown;
  pincode?: unknown;
  language?: unknown;
  current_status?: unknown;
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole(IMPORT_ROLES);

  const body = await req.json().catch(() => ({}));
  const leads: IncomingLead[] = Array.isArray(body?.leads) ? body.leads : [];

  if (leads.length === 0) {
    return errorResponse("No leads provided", 400);
  }
  if (leads.length > MAX_IMPORT_ROWS) {
    return errorResponse(
      `Too many rows — ${leads.length} received, limit is ${MAX_IMPORT_ROWS}. Use Bulk Lead Upload for larger sheets.`,
      400,
    );
  }

  // 1. Normalise every phone up front, then one lookup for the whole batch.
  const normalized = leads.map((l) => normalizePhone(str(l.phone)));
  const existingByPhone = await loadExistingByPhone(
    normalized.filter((p): p is string => !!p),
  );

  const result = {
    inserted: 0,
    reactivated: 0,
    duplicate_skipped: 0,
    address_mismatch: 0,
    invalid_phone: 0,
    failed: 0,
  };
  // Row-level detail so the modal can tell the operator WHICH rows were dropped
  // and why, instead of a bare skipped count they can't act on.
  const details: Array<{
    row: number;
    phone: string | null;
    outcome: string;
    duplicate_lead_id?: string | null;
    error?: string;
  }> = [];

  // In-batch duplicates: the same phone twice in one sheet must not insert
  // twice. dealer_leads.phone is UNIQUE so the second would fail anyway — this
  // reports it as a duplicate rather than a server error.
  const seenInBatch = new Set<string>();

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    const rowNo = i + 1;
    const phone = normalized[i];

    if (!phone) {
      result.invalid_phone++;
      details.push({ row: rowNo, phone: null, outcome: "invalid_phone" });
      continue;
    }

    if (seenInBatch.has(phone)) {
      result.duplicate_skipped++;
      details.push({ row: rowNo, phone, outcome: "duplicate_in_file" });
      continue;
    }
    seenInBatch.add(phone);

    // Structured region: prefer explicit state/city columns, fall back to
    // splitting `location` so legacy single-cell imports still populate them.
    const canonicalCity =
      normalizeCity(str(lead.city) || str(lead.location) || undefined) ?? null;
    const canonicalState =
      normalizeState(str(lead.state) || undefined) ??
      inferStateFromCity(canonicalCity) ??
      null;

    const { outcome, duplicateLeadId } = classifyAgainstExisting(
      canonicalCity ?? "",
      existingByPhone.get(phone),
    );

    try {
      switch (outcome) {
        case "reactivate":
          // BRD §0.9 — a Lost dealer coming back on a sheet is a revival, not a
          // new lead. The old route silently dropped these.
          await reactivateLead({
            leadId: duplicateLeadId!,
            trigger: "upload",
            performedBy: user.id,
            notes: "Reactivated via /leads Import",
          });
          result.reactivated++;
          details.push({ row: rowNo, phone, outcome, duplicate_lead_id: duplicateLeadId });
          break;

        case "address_mismatch":
          // Same dealer, different city — neither side can decide which is
          // right, so a human resolves it. Recorded, never silently merged.
          // Same request_type + column set the bulk wizard's commit route uses,
          // so both feed one admin queue.
          await db.execute(sql`
            INSERT INTO duplicate_merge_requests
                (request_type, source_lead_id, target_lead_id, requested_by,
                 request_notes, status)
            VALUES ('address_mismatch_upload', NULL, ${duplicateLeadId},
                ${user.id},
                ${`/leads Import row ${rowNo}: phone ${phone} matched an existing lead; imported address "${canonicalCity ?? "(none)"}, ${canonicalState ?? "(none)"}" differs.`},
                'pending')
          `);
          result.address_mismatch++;
          details.push({ row: rowNo, phone, outcome, duplicate_lead_id: duplicateLeadId });
          break;

        case "duplicate_skip":
          result.duplicate_skipped++;
          details.push({ row: rowNo, phone, outcome, duplicate_lead_id: duplicateLeadId });
          break;

        case "valid":
          await db.insert(dealerLeads).values({
            id: `DL-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
            dealer_name: str(lead.dealer_name) || null,
            phone,
            shop_name: str(lead.shop_name) || null,
            location: str(lead.location) || canonicalCity,
            state: canonicalState,
            city: canonicalCity,
            area: str(lead.area) || null,
            pincode: str(lead.pincode) || null,
            language: str(lead.language) || "hindi",
            current_status: str(lead.current_status) || "new",
            source: "manual_upload_lead",
            total_attempts: 0,
          });
          result.inserted++;
          details.push({ row: rowNo, phone, outcome });
          break;
      }
    } catch (err) {
      // One bad row must not abort the whole sheet.
      result.failed++;
      details.push({
        row: rowNo,
        phone,
        outcome: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json({
    success: true,
    ...result,
    // Back-compat: the modal reads `skipped`. Everything that didn't insert.
    skipped:
      result.duplicate_skipped +
      result.address_mismatch +
      result.invalid_phone +
      result.failed,
    details,
  });
});
