/**
 * NBFC master GET/PATCH — preserves URL contract /api/admin/nbfc/{id}.
 *
 * Migrated here (E-007) so the param name matches its sibling segments
 * (approve, approval-readiness, lsp-agreement, etc.) which all use
 * `[nbfcId]`. Next.js 16 / Turbopack rejects sibling slugs with different
 * names — this route formerly lived under `[id]/route.ts` and the new
 * file replaces it without changing any caller-visible URL or response.
 *
 * Behaviour preserved bit-for-bit from the prior `[id]/route.ts`:
 *   - GET returns the full NBFC master row (camelCase response keys).
 *   - PATCH updates whitelisted fields, with LOCKED_STATUSES enforcing
 *     the safelist contact/grievance carve-out.
 *   - Auth: admin (or test bypass) — admin roles unchanged.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import {
  nbfc,
  nbfcComplianceDocuments,
  nbfcCorExpiryAlerts,
  nbfcDirectorKycVerifications,
  nbfcDirectors,
  nbfcEntityKycVerifications,
  nbfcLspAgreements,
  nbfcStatusHistory,
  users,
} from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";

const ADMIN_ROLES = [
  "admin",
  "ceo",
  "business_head",
  "sales_head",
  "sales_manager",
  "sales_executive",
] as const;

const SAFELIST_FIELDS = new Set([
  "primaryContactName",
  "primaryContactEmail",
  "primaryContactPhone",
  "grievanceOfficerName",
  "grievanceHelpline",
  "grievanceUrl",
  "nodalOfficer",
]);

const LOCKED_STATUSES = new Set(["approved", "active", "terminated"]);

function isTestBypassAllowed() {
  return (
    process.env.NODE_ENV !== "production" &&
    (process.env.NBFC_TEST_BYPASS === "1" ||
      process.env.PLAYWRIGHT_TEST === "1" ||
      process.env.NEXT_PUBLIC_NBFC_TEST_MODE === "1")
  );
}

async function requireAdmin(req: NextRequest) {
  if (isTestBypassAllowed()) {
    const headerId = req.headers.get("x-test-admin-id");
    const allowedHeader = req.headers.get("x-test-admin-secret");
    if (
      headerId &&
      allowedHeader &&
      allowedHeader === (process.env.NBFC_TEST_BYPASS_SECRET || "test-bypass")
    ) {
      const numericId = Number(headerId);
      if (!Number.isFinite(numericId)) return null;
      return { id: numericId as unknown as string, role: "admin", name: "Test Admin" };
    }
  }

  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) return null;

  let dbUser =
    (
      await db
        .select({ id: users.id, role: users.role, name: users.name })
        .from(users)
        .where(eq(users.id, user.id))
        .limit(1)
    )[0] ?? null;

  if (!dbUser && user.email) {
    dbUser =
      (
        await db
          .select({ id: users.id, role: users.role, name: users.name })
          .from(users)
          .where(eq(users.email, user.email))
          .limit(1)
      )[0] ?? null;
  }

  if (!dbUser) return null;
  if (!ADMIN_ROLES.includes(dbUser.role as (typeof ADMIN_ROLES)[number])) {
    return null;
  }
  return dbUser;
}

const patchSchema = z
  .object({
    legalName: z.string().min(1).max(200).optional(),
    shortName: z.string().min(1).max(100).optional(),
    cin: z.string().min(1).max(25).optional(),
    gstNumber: z.string().optional(),
    panNumber: z.string().optional(),
    nbfcType: z.string().optional(),
    registeredAddress: z.unknown().optional(),
    activeGeographies: z.array(z.string()).optional(),
    primaryContactName: z.string().min(1).max(200).optional(),
    primaryContactEmail: z.string().email().optional(),
    primaryContactPhone: z.string().regex(/^\d{10}$/).optional(),
    grievanceOfficerName: z.string().min(1).max(200).optional(),
    grievanceHelpline: z.string().min(1).max(200).optional(),
    grievanceUrl: z.string().url().optional(),
    nodalOfficer: z.string().max(200).optional(),
    partnershipDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    fldgTerms: z.string().optional(),
    status: z.string().optional(),
  })
  .partial();

const camelToSnake: Record<string, string> = {
  legalName: "legal_name",
  shortName: "short_name",
  cin: "cin",
  gstNumber: "gst_number",
  panNumber: "pan_number",
  nbfcType: "nbfc_type",
  registeredAddress: "registered_address",
  activeGeographies: "active_geographies",
  primaryContactName: "primary_contact_name",
  primaryContactEmail: "primary_contact_email",
  primaryContactPhone: "primary_contact_phone",
  grievanceOfficerName: "grievance_officer_name",
  grievanceHelpline: "grievance_helpline",
  grievanceUrl: "grievance_url",
  nodalOfficer: "nodal_officer",
  partnershipDate: "partnership_date",
  fldgTerms: "fldg_terms",
  status: "status",
};

function parseId(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ nbfcId: string }> },
) {
  try {
    const admin = await requireAdmin(req);
    if (!admin) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 403 },
      );
    }
    const { nbfcId: rawId } = await context.params;
    const id = parseId(rawId);
    if (id === null) {
      return NextResponse.json(
        { success: false, error: "invalid_id" },
        { status: 400 },
      );
    }
    const rows = await db.select().from(nbfc).where(eq(nbfc.id, id)).limit(1);
    const row = rows[0];
    if (!row) {
      return NextResponse.json(
        { success: false, error: "not_found" },
        { status: 404 },
      );
    }
    return NextResponse.json({
      success: true,
      id: row.id,
      nbfcId: row.nbfc_id,
      legalName: row.legal_name,
      shortName: row.short_name,
      rbiRegistrationNo: row.rbi_registration_no,
      cin: row.cin,
      gstNumber: row.gst_number,
      panNumber: row.pan_number,
      nbfcType: row.nbfc_type,
      registeredAddress: row.registered_address,
      activeGeographies: row.active_geographies,
      primaryContactName: row.primary_contact_name,
      primaryContactEmail: row.primary_contact_email,
      primaryContactPhone: row.primary_contact_phone,
      grievanceOfficerName: row.grievance_officer_name,
      grievanceHelpline: row.grievance_helpline,
      grievanceUrl: row.grievance_url,
      nodalOfficer: row.nodal_officer,
      partnershipDate: row.partnership_date,
      fldgTerms: row.fldg_terms,
      corExpiryDate: row.cor_expiry_date,
      lspAgreementId: row.lsp_agreement_id,
      status: row.status,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    console.error("GET /api/admin/nbfc/[nbfcId] error:", err);
    return NextResponse.json(
      { success: false, error: "server_error" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ nbfcId: string }> },
) {
  try {
    const admin = await requireAdmin(req);
    if (!admin) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 403 },
      );
    }
    const { nbfcId: rawId } = await context.params;
    const id = parseId(rawId);
    if (id === null) {
      return NextResponse.json(
        { success: false, error: "invalid_id" },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid JSON" },
        { status: 400 },
      );
    }
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {};
      const formErrors: string[] = [];
      for (const issue of parsed.error.issues) {
        if (issue.path.length === 0) {
          formErrors.push(issue.message);
          continue;
        }
        const key = issue.path.join(".");
        if (!fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      return NextResponse.json(
        {
          success: false,
          error: "validation_failed",
          details: { fieldErrors, formErrors },
        },
        { status: 422 },
      );
    }
    const patch = parsed.data;

    const existingRows = await db
      .select()
      .from(nbfc)
      .where(eq(nbfc.id, id))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) {
      return NextResponse.json(
        { success: false, error: "not_found" },
        { status: 404 },
      );
    }

    if (LOCKED_STATUSES.has(existing.status)) {
      for (const key of Object.keys(patch)) {
        if (!SAFELIST_FIELDS.has(key)) {
          return NextResponse.json(
            {
              success: false,
              error: "field_locked_for_status",
              field: key,
              status: existing.status,
            },
            { status: 409 },
          );
        }
      }
    }

    const update: Record<string, unknown> = { updated_at: new Date() };
    for (const [k, v] of Object.entries(patch)) {
      const col = camelToSnake[k];
      if (!col) continue;
      update[col] = v;
    }

    const updated = await db
      .update(nbfc)
      .set(update)
      .where(eq(nbfc.id, id))
      .returning({
        id: nbfc.id,
        nbfc_id: nbfc.nbfc_id,
        status: nbfc.status,
        updated_at: nbfc.updated_at,
      });

    const row = updated[0];
    return NextResponse.json({
      success: true,
      id: row.id,
      nbfcId: row.nbfc_id,
      status: row.status,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    console.error("PATCH /api/admin/nbfc/[nbfcId] error:", err);
    return NextResponse.json(
      { success: false, error: "server_error" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/admin/nbfc/{id} — hard-delete a draft NBFC.
 *
 * Constraints (per the My Submitted Drafts UX):
 *   - Status must be `draft` (409 otherwise — submitted/approved/active rows
 *     are part of downstream flows and must not vanish).
 *   - Only the creator (matched on `created_by_auth_id` UUID = viewer auth
 *     id) may delete. The Admin role gate from requireAdmin still applies.
 *   - Cascades inside a transaction: status history → LSP agreements →
 *     compliance documents → directors → nbfc row. A draft never has loan
 *     sanctions or dealer assignments referencing it, so no other tables
 *     need cleanup.
 */
export async function DELETE(
  req: NextRequest,
  context: { params: Promise<{ nbfcId: string }> },
) {
  try {
    const admin = await requireAdmin(req);
    if (!admin) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 403 },
      );
    }
    const { nbfcId: rawId } = await context.params;
    const id = parseId(rawId);
    if (id === null) {
      return NextResponse.json(
        { success: false, error: "invalid_id" },
        { status: 400 },
      );
    }

    const [existing] = await db
      .select({
        id: nbfc.id,
        status: nbfc.status,
        created_by_auth_id: nbfc.created_by_auth_id,
      })
      .from(nbfc)
      .where(eq(nbfc.id, id))
      .limit(1);

    if (!existing) {
      return NextResponse.json(
        { success: false, error: "not_found" },
        { status: 404 },
      );
    }

    if (existing.status !== "draft") {
      return NextResponse.json(
        {
          success: false,
          error: "INVALID_STATE",
          message:
            "Only drafts can be deleted. Submitted/approved NBFCs are part of downstream flows.",
          currentStatus: existing.status,
        },
        { status: 409 },
      );
    }

    if (
      !existing.created_by_auth_id ||
      String(existing.created_by_auth_id) !== String(admin.id)
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "not_owner",
          message: "Only the creator of this draft can delete it.",
        },
        { status: 403 },
      );
    }

    await db.transaction(async (tx) => {
      // Director KYC rows reference nbfcDirectors.id — clear them first so
      // the nbfcDirectors delete below doesn't trip the FK.
      const directorIds = (
        await tx
          .select({ id: nbfcDirectors.id })
          .from(nbfcDirectors)
          .where(eq(nbfcDirectors.nbfc_id, id))
      ).map((r) => r.id);
      if (directorIds.length > 0) {
        await tx
          .delete(nbfcDirectorKycVerifications)
          .where(inArray(nbfcDirectorKycVerifications.director_id, directorIds));
      }

      await tx
        .delete(nbfcEntityKycVerifications)
        .where(eq(nbfcEntityKycVerifications.nbfc_id, id));
      await tx
        .delete(nbfcCorExpiryAlerts)
        .where(eq(nbfcCorExpiryAlerts.nbfc_id, id));
      await tx.delete(nbfcStatusHistory).where(eq(nbfcStatusHistory.nbfc_id, id));
      await tx.delete(nbfcLspAgreements).where(eq(nbfcLspAgreements.nbfc_id, id));
      await tx
        .delete(nbfcComplianceDocuments)
        .where(eq(nbfcComplianceDocuments.nbfc_id, id));
      await tx.delete(nbfcDirectors).where(eq(nbfcDirectors.nbfc_id, id));
      await tx.delete(nbfc).where(eq(nbfc.id, id));
    });

    return NextResponse.json({ success: true, deletedId: id });
  } catch (err) {
    console.error("DELETE /api/admin/nbfc/[nbfcId] error:", err);
    return NextResponse.json(
      { success: false, error: "server_error" },
      { status: 500 },
    );
  }
}
