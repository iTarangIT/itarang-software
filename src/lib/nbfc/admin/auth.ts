/**
 * Admin auth + actor resolution for the NBFC admin surface.
 *
 * In production this delegates to the canonical admin idiom — Supabase session
 * + role check against the `users` table. The admin role set is shared with
 * `src/app/api/admin/kyc-reviews/route.ts`.
 *
 * In non-production environments, when both:
 *   1. process.env.NBFC_TEST_BYPASS_SECRET is set, AND
 *   2. The request carries an `x-nbfc-test-bypass` header equal to that secret,
 *
 * the additional header `x-nbfc-test-admin-id` is accepted to fabricate an
 * admin actor (a numeric users.id surrogate is OK for tests). This bypass is
 * triple-guarded (env != production, server secret, matching request header)
 * so a leaked header alone is not enough.
 */
import { createClient } from "@/lib/supabase/server";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export const ADMIN_ROLES = [
  "admin",
  "ceo",
  "business_head",
  "sales_head",
  "sales_manager",
  "sales_executive",
] as const;

export type AdminActor = {
  user_id: string; // uuid for session, numeric string for test bypass
  numeric_id: number; // surrogate integer used by nbfc_compliance_documents.uploaded_by/verified_by/rejected_by
  role: string;
  via: "session" | "test_bypass";
};

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

export function isTestBypassRequest(headers: Headers): boolean {
  if (isProd()) return false;
  const secret = process.env.NBFC_TEST_BYPASS_SECRET;
  if (!secret) return false;
  const provided = headers.get("x-nbfc-test-bypass");
  return !!provided && provided === secret;
}

/**
 * Resolve a numeric admin id. The `users` table uses uuid primary keys, but
 * `nbfc_compliance_documents.uploaded_by/verified_by/rejected_by` are integers
 * (NBFC-side tables use numeric ids per BRD). We hash the uuid down to a
 * 31-bit positive integer so the same admin always maps to the same surrogate.
 */
function uuidToInt(uuid: string): number {
  let h = 0;
  for (let i = 0; i < uuid.length; i++) {
    h = (h * 31 + uuid.charCodeAt(i)) | 0;
  }
  return Math.abs(h) || 1;
}

export async function resolveAdminActor(headers: Headers): Promise<AdminActor> {
  if (isTestBypassRequest(headers)) {
    const adminId = headers.get("x-nbfc-test-admin-id");
    const role = headers.get("x-nbfc-test-admin-role") ?? "admin";
    if (!adminId) {
      throw new Error(
        "UNAUTHORIZED: test bypass missing x-nbfc-test-admin-id header",
      );
    }
    const numeric = Number.parseInt(adminId, 10);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      throw new Error("UNAUTHORIZED: x-nbfc-test-admin-id must be a positive integer");
    }
    return {
      user_id: adminId,
      numeric_id: numeric,
      role,
      via: "test_bypass",
    };
  }

  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    throw new Error("UNAUTHORIZED: no session user");
  }
  const rows = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const row = rows[0];
  if (!row || !ADMIN_ROLES.includes(row.role as (typeof ADMIN_ROLES)[number])) {
    throw new Error("FORBIDDEN: not an admin");
  }
  return {
    user_id: row.id,
    numeric_id: uuidToInt(row.id),
    role: row.role,
    via: "session",
  };
}

export function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("UNPROCESSABLE")) return 422;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}
