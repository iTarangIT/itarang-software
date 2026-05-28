import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { nbfc, nbfcDirectors, users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";

const ADMIN_ROLES = [
  "admin",
  "ceo",
  "business_head",
  "sales_head",
  "sales_manager",
  "sales_executive",
] as const;

// Allow tests to bypass Supabase auth in non-prod/test environments by
// supplying x-test-admin-id (triple-guarded per worktree lessons).
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

// Letters + space + . ' - so Indian names/places (St. Thomas Mount, D'Souza,
// Jean-Paul) survive while digits and symbols are rejected.
const ALPHA_NAME_RE = /^[A-Za-z\s.'\-]+$/;
const ALPHA_NAME_MSG = "Letters only";

const createSchema = z.object({
  legalName: z.string().min(1).max(200),
  shortName: z.string().min(1).max(100),
  rbiRegistrationNo: z
    .string()
    .regex(/^N-\d{2}\.\d{5}\.\d{2}\.\d{2}\.\d{4}\.\d{5}\.\d{2}$/),
  cin: z.string().min(1).max(25),
  gstNumber: z
    .string()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}Z[A-Z\d]{1}$/),
  panNumber: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/),
  nbfcType: z.enum([
    "nbfc_icc",
    "nbfc_mfi",
    "nbfc_factor",
    "hfc",
    "scheduled_bank",
    "cooperative_bank",
    "other",
  ]),
  registeredAddress: z.object({
    line1: z.string().min(1),
    line2: z.string().optional(),
    city: z.string().min(1).regex(ALPHA_NAME_RE, ALPHA_NAME_MSG),
    district: z.string().min(1).regex(ALPHA_NAME_RE, ALPHA_NAME_MSG),
    state: z.string().min(1).regex(ALPHA_NAME_RE, ALPHA_NAME_MSG),
    pin: z.string().regex(/^\d{6}$/),
  }),
  primaryContactName: z.string().min(1).max(200).regex(ALPHA_NAME_RE, ALPHA_NAME_MSG),
  primaryContactEmail: z.string().email(),
  primaryContactPhone: z.string().regex(/^\d{10}$/),
  grievanceOfficerName: z.string().min(1).max(200).regex(ALPHA_NAME_RE, ALPHA_NAME_MSG),
  grievanceHelpline: z.string().min(1).max(200),
  grievanceUrl: z.string().url(),
  nodalOfficer: z.string().max(200).optional(),
  partnershipDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fldgTerms: z.string().optional(),
  activeGeographies: z
    .array(z.string().transform((s) => s.trim().toUpperCase()))
    .min(1)
    .refine((arr) => arr.every((s) => /^[A-Z]{2}$/.test(s)), {
      message: "Each geography must be a two-letter state code (e.g. MH, GJ)",
    }),
});

function generateNbfcId() {
  // 8-char uppercase alphanumeric — collision-resistant for the workload.
  const bytes = crypto.randomBytes(8);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let suffix = "";
  for (let i = 0; i < 8; i++) {
    suffix += alphabet[bytes[i] % alphabet.length];
  }
  return `NBFC-${suffix}`;
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin(req);
    if (!admin) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 403 },
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

    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      // Walk issues into a flat path-keyed map so the client can highlight
      // each offending input by name (incl. nested registeredAddress.*).
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
    const v = parsed.data;

    // created_by must be a numeric id; if admin.id is uuid (real user) and
    // schema needs integer, store best-effort 0 — keeps test bypass + real
    // path both functional. Real production path is wired to numeric users.
    const createdBy =
      typeof admin.id === "number"
        ? (admin.id as unknown as number)
        : 0;
    // E-108 — the real ownership signal. Stored as uuid alongside the legacy
    // integer column so /admin/nbfc?owner=me can scope drafts to the viewer.
    const createdByAuthId =
      typeof admin.id === "string" ? (admin.id as string) : null;

    // Try insert with retry-on-collision for nbfc_id (rare).
    let attempt = 0;
    while (attempt < 5) {
      const candidateNbfcId = generateNbfcId();
      try {
        const inserted = await db
          .insert(nbfc)
          .values({
            nbfc_id: candidateNbfcId,
            legal_name: v.legalName,
            short_name: v.shortName,
            rbi_registration_no: v.rbiRegistrationNo,
            cin: v.cin,
            gst_number: v.gstNumber,
            pan_number: v.panNumber,
            nbfc_type: v.nbfcType,
            registered_address: v.registeredAddress,
            active_geographies: v.activeGeographies,
            primary_contact_name: v.primaryContactName,
            primary_contact_email: v.primaryContactEmail,
            primary_contact_phone: v.primaryContactPhone,
            grievance_officer_name: v.grievanceOfficerName,
            grievance_helpline: v.grievanceHelpline,
            grievance_url: v.grievanceUrl,
            nodal_officer: v.nodalOfficer ?? null,
            partnership_date: v.partnershipDate,
            fldg_terms: v.fldgTerms ?? null,
            status: "draft",
            created_by: createdBy,
            created_by_auth_id: createdByAuthId,
          })
          .returning({
            id: nbfc.id,
            nbfc_id: nbfc.nbfc_id,
            status: nbfc.status,
          });

        const row = inserted[0];

        // Seed the director record from primary contact so sanchit can run
        // PAN/Aadhaar/RC against an addressable subject during KYC review.
        // PAN reuses the entity PAN by default; the reviewer can edit it on
        // the KYC review page before kicking off the verification.
        await db.insert(nbfcDirectors).values({
          nbfc_id: row.id,
          full_name: v.primaryContactName,
          email: v.primaryContactEmail,
          phone: v.primaryContactPhone,
          pan_number: v.panNumber,
          kyc_status: "pending",
        });

        return NextResponse.json(
          {
            success: true,
            id: row.id,
            nbfcId: row.nbfc_id,
            status: row.status,
          },
          { status: 200 },
        );
      } catch (err: unknown) {
        // Drizzle wraps the underlying pg error in `cause`. Walk the chain.
        type PgErrLike = {
          code?: string;
          message?: string;
          constraint?: string;
          constraint_name?: string;
          detail?: string;
          cause?: unknown;
        };
        const chain: PgErrLike[] = [];
        let cur: unknown = err;
        for (let depth = 0; depth < 5 && cur; depth++) {
          chain.push(cur as PgErrLike);
          cur = (cur as PgErrLike)?.cause;
        }
        const code = chain.map((e) => e.code).find(Boolean);
        const constraint =
          chain.map((e) => e.constraint || e.constraint_name).find(Boolean) ||
          "";
        const detail = chain.map((e) => e.detail).find(Boolean) || "";
        const message = chain
          .map((e) => e.message)
          .filter(Boolean)
          .join(" | ")
          .toLowerCase();
        const blob = `${constraint} ${detail} ${message}`.toLowerCase();

        const isUnique =
          code === "23505" ||
          message.includes("duplicate key") ||
          message.includes("unique constraint");

        if (isUnique) {
          if (blob.includes("rbi_registration_no")) {
            return NextResponse.json(
              {
                success: false,
                error: "rbi_registration_no_already_exists",
              },
              { status: 409 },
            );
          }
          // Otherwise assume nbfc_id collision: retry.
          attempt++;
          continue;
        }
        throw err;
      }
    }

    return NextResponse.json(
      { success: false, error: "nbfc_id_generation_failed" },
      { status: 500 },
    );
  } catch (err) {
    console.error("POST /api/admin/nbfc error:", err);
    return NextResponse.json(
      { success: false, error: "server_error" },
      { status: 500 },
    );
  }
}
