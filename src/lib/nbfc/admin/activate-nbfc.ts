/**
 * E-112 — Reusable NBFC activation helper.
 *
 * The body of POST /api/admin/nbfc/{nbfcId}/activate, extracted so the Digio
 * webhook can auto-activate an NBFC once the LSP agreement reaches COMPLETED.
 * The HTTP route in `activate/route.ts` wraps this helper with CEO auth +
 * request parsing; the webhook calls this directly with a system performedBy
 * (defaulting to the CEO who approved the NBFC).
 *
 * Idempotent — if the NBFC is already `active`, returns the existing
 * credential without re-provisioning Supabase users or re-emailing.
 */
import { eq, sql } from "drizzle-orm";
import { randomUUID, randomInt } from "node:crypto";
import { db } from "@/lib/db";
import {
  auditLogs,
  nbfc,
  nbfcPortalCredentials,
  nbfcTenants,
  users,
} from "@/lib/db/schema";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { enqueueNbfcPortalCredentialsJob } from "@/lib/queue/jobs/sendNbfcPortalCredentialsJob";

export interface ActivateNbfcResult {
  ok: boolean;
  credentialId?: string;
  credentialDispatchedTo?: string;
  alreadyActive?: boolean;
  error?: string;
}

const PWD_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PWD_LOWER = "abcdefghjkmnpqrstuvwxyz";
const PWD_DIGIT = "23456789";
const PWD_SYMBOL = "!@#$%^&*-_=+";
const PWD_ALL = PWD_UPPER + PWD_LOWER + PWD_DIGIT + PWD_SYMBOL;

function pickFrom(set: string): string {
  return set[randomInt(0, set.length)];
}

export function generatePortalPassword(): string {
  const chars: string[] = [
    pickFrom(PWD_UPPER),
    pickFrom(PWD_LOWER),
    pickFrom(PWD_DIGIT),
    pickFrom(PWD_SYMBOL),
  ];
  for (let i = chars.length; i < 20; i++) chars.push(pickFrom(PWD_ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const head = local.slice(0, 2);
  return `${head}${"*".repeat(Math.max(2, local.length - 2))}${domain}`;
}

async function ensureSupabaseUser(
  email: string,
  password: string,
): Promise<string> {
  if (
    process.env.NODE_ENV !== "production" &&
    (!process.env.NEXT_PUBLIC_SUPABASE_URL ||
      !process.env.SUPABASE_SERVICE_ROLE_KEY)
  ) {
    return randomUUID();
  }
  const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    password,
    user_metadata: { role: "nbfc_partner" },
  });
  if (created?.user?.id) return created.user.id;
  if (error && /already|exists|registered/i.test(error.message ?? "")) {
    const { data: list } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 200,
    });
    const found = list?.users?.find(
      (u) => (u.email ?? "").toLowerCase() === email.toLowerCase(),
    );
    if (found?.id) {
      await supabaseAdmin.auth.admin.updateUserById(found.id, { password });
      return found.id;
    }
  }
  throw new Error(
    `Failed to provision Supabase auth user for ${email}: ${error?.message ?? "unknown"}`,
  );
}

export interface ActivateOptions {
  /** Required only when the NBFC is in 'approved' state. Falls back to
   * nbfc.approved_by if not provided. */
  performedBy?: string;
  /** Skip Supabase user creation / email dispatch. Useful for tests. */
  skipDispatch?: boolean;
}

/**
 * Activate an NBFC: provision Supabase user, seed tenant, flip status, enqueue
 * credential email. Idempotent — repeat calls on `active` NBFCs are no-ops.
 */
export async function activateNbfc(
  nbfcId: number,
  opts: ActivateOptions = {},
): Promise<ActivateNbfcResult> {
  const [row] = await db
    .select({
      id: nbfc.id,
      nbfc_id: nbfc.nbfc_id,
      legal_name: nbfc.legal_name,
      status: nbfc.status,
      primary_contact_email: nbfc.primary_contact_email,
      primary_contact_name: nbfc.primary_contact_name,
      rbi_registration_no: nbfc.rbi_registration_no,
      grievance_url: nbfc.grievance_url,
      grievance_helpline: nbfc.grievance_helpline,
      approved_by: nbfc.approved_by,
    })
    .from(nbfc)
    .where(eq(nbfc.id, nbfcId))
    .limit(1);
  if (!row) {
    return { ok: false, error: "NBFC_NOT_FOUND" };
  }
  if (row.status === "active") {
    return { ok: true, alreadyActive: true };
  }
  if (row.status !== "approved") {
    return { ok: false, error: `MUST_BE_APPROVED_status_${row.status}` };
  }

  const performedBy =
    opts.performedBy ??
    (typeof row.approved_by === "string" ? row.approved_by : null);
  if (!performedBy) {
    return { ok: false, error: "NO_PERFORMED_BY" };
  }

  const password = generatePortalPassword();
  let supabaseUserId: string;
  try {
    supabaseUserId = await ensureSupabaseUser(
      row.primary_contact_email,
      password,
    );
  } catch (err) {
    return {
      ok: false,
      error: `SUPABASE_USER_PROVISION_FAILED: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const credentialId = randomUUID();
  await db.insert(nbfcPortalCredentials).values({
    id: credentialId,
    nbfc_id: nbfcId,
    supabase_user_id: supabaseUserId,
    dispatch_status: "pending",
  });

  const now = new Date();
  await db
    .update(nbfc)
    .set({
      status: "active",
      activated_at: now,
      updated_at: now,
    })
    .where(eq(nbfc.id, nbfcId));

  // Seed tenant + users + nbfc_users.
  const tenantSlug = row.nbfc_id.toLowerCase();
  let tenantId: string;
  const existingTenant = await db
    .select({ id: nbfcTenants.id })
    .from(nbfcTenants)
    .where(eq(nbfcTenants.slug, tenantSlug))
    .limit(1);
  if (existingTenant.length) {
    tenantId = existingTenant[0].id;
    await db
      .update(nbfcTenants)
      .set({
        display_name: row.legal_name,
        contact_email: row.primary_contact_email,
        is_active: true,
        nbfc_legal_name: row.legal_name,
        rbi_registration_no: row.rbi_registration_no,
        grievance_url: row.grievance_url,
        grievance_helpline: row.grievance_helpline,
        updated_at: now,
      })
      .where(eq(nbfcTenants.id, tenantId));
  } else {
    const [created] = await db
      .insert(nbfcTenants)
      .values({
        slug: tenantSlug,
        display_name: row.legal_name,
        contact_email: row.primary_contact_email,
        is_active: true,
        nbfc_legal_name: row.legal_name,
        rbi_registration_no: row.rbi_registration_no,
        grievance_url: row.grievance_url,
        grievance_helpline: row.grievance_helpline,
      })
      .returning({ id: nbfcTenants.id });
    tenantId = created.id;
  }

  await db
    .insert(users)
    .values({
      id: supabaseUserId,
      email: row.primary_contact_email,
      name: row.primary_contact_name,
      role: "nbfc_partner",
    })
    .onConflictDoUpdate({
      target: users.id,
      set: { role: "nbfc_partner", updated_at: now },
    });

  await db.execute(sql`
    INSERT INTO nbfc_users (user_id, tenant_id, role)
    SELECT ${supabaseUserId}::uuid, ${tenantId}::uuid, 'admin'
    WHERE NOT EXISTS (
      SELECT 1 FROM nbfc_users
      WHERE user_id = ${supabaseUserId}::uuid AND tenant_id = ${tenantId}::uuid
    )
  `);

  // Enqueue email — on failure, leave status as 'active' so the admin can use
  // /activate?resend=true to retry. The autonomous webhook path can't fail
  // backwards (the agreement is already COMPLETED) so the credential dispatch
  // is best-effort here.
  if (!opts.skipDispatch) {
    try {
      await enqueueNbfcPortalCredentialsJob({
        nbfcId,
        credentialId,
        toEmail: row.primary_contact_email,
        password,
        supabaseUserId,
      });
      await db
        .update(nbfcPortalCredentials)
        .set({
          dispatch_status: "dispatched",
          email_dispatched_at: new Date(),
        })
        .where(eq(nbfcPortalCredentials.id, credentialId));
    } catch (err) {
      await db
        .update(nbfcPortalCredentials)
        .set({ dispatch_status: "credential_dispatch_failed" })
        .where(eq(nbfcPortalCredentials.id, credentialId));
      console.error(
        "[activateNbfc] credential email enqueue failed",
        err instanceof Error ? err.message : err,
      );
    }
  }

  await db.insert(auditLogs).values({
    id: randomUUID(),
    entity_type: "nbfc",
    entity_id: String(nbfcId),
    action: "nbfc.activated",
    performed_by: performedBy,
    new_data: {
      status: "active",
      activated_at: now.toISOString(),
      credentialId,
      credentialDispatchedTo: maskEmail(row.primary_contact_email),
      trigger: opts.performedBy ? "manual" : "auto_after_signing",
    },
  });

  return {
    ok: true,
    credentialId,
    credentialDispatchedTo: maskEmail(row.primary_contact_email),
  };
}
