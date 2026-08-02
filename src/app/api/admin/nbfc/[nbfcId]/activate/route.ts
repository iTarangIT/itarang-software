/**
 * E-002 — POST /api/admin/nbfc/{nbfcId}/activate
 *
 * Activation gate (BRD §6.0.2 Step 6). Once an NBFC is approved (E-001),
 * an admin clicks Activate which:
 *   1. Verifies status='approved' (else 409).
 *   2. Provisions a Supabase auth user for primary_contact_email if absent.
 *   3. Generates a high-entropy one-time password (>=16 chars, mixed-case +
 *      digit + symbol).
 *   4. Records dispatch row in nbfc_portal_credentials.
 *   5. Flips status to 'active' and stamps activated_at.
 *   6. Enqueues an email job to primary_contact_email. On enqueue failure,
 *      reverts status to 'approved' and returns 500 (NEVER silently lose
 *      state — non_functional G-01).
 *   7. Returns ok with the masked email.
 *
 * Triple-guarded test bypass mirrors E-001/E-003 — `x-nbfc-test-bypass` +
 * `x-nbfc-test-user-id` headers, gated by NODE_ENV !== 'production' and
 * NBFC_TEST_BYPASS_SECRET env.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { randomUUID, randomInt } from "node:crypto";
import { db } from "@/lib/db";
import {
  nbfc,
  nbfcLspAgreements,
  nbfcLspAgreementSigners,
  nbfcPortalCredentials,
  nbfcTenants,
  nbfcUsers,
  users,
  auditLogs,
} from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { enqueueNbfcPortalCredentialsJob } from "@/lib/queue/jobs/sendNbfcPortalCredentialsJob";
import { downloadPdfBuffer } from "@/lib/email/downloadPdfBuffer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ActivateBody = z.object({
  resend: z.boolean().optional(),
});

const PWD_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const PWD_LOWER = "abcdefghjkmnpqrstuvwxyz";
const PWD_DIGIT = "23456789";
const PWD_SYMBOL = "!@#$%^&*-_=+";
const PWD_ALL = PWD_UPPER + PWD_LOWER + PWD_DIGIT + PWD_SYMBOL;

function pickFrom(set: string): string {
  return set[randomInt(0, set.length)];
}

/**
 * High-entropy password: 20 characters, drawn from upper/lower/digit/symbol
 * pools so every category is represented at least once. Returns >= 16 chars
 * per non_functional rule.
 */
export function generatePortalPassword(): string {
  const chars: string[] = [
    pickFrom(PWD_UPPER),
    pickFrom(PWD_LOWER),
    pickFrom(PWD_DIGIT),
    pickFrom(PWD_SYMBOL),
  ];
  for (let i = chars.length; i < 20; i++) chars.push(pickFrom(PWD_ALL));
  // Shuffle (Fisher-Yates) using crypto random.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

function maskEmail(email: string): string {
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
  // Bypass only when Supabase admin credentials are unavailable (e.g. agent
  // worktrees that don't carry .env.local). With keys present we always go
  // through the real path so the password we email actually unlocks login.
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
  // Duplicate — look up by email and reset the password so the credential
  // we're about to email matches what Supabase actually accepts.
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

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ nbfcId: string }> },
) {
  // Outer guard: every code path below MUST resolve to a JSON response. An
  // unhandled throw here returns a 500 with an EMPTY body, which surfaces in
  // the admin UI as the opaque "Failed to execute 'json' on 'Response':
  // Unexpected end of JSON input". Wrapping the whole handler converts any
  // unexpected DB/network failure into a readable JSON error envelope so the
  // operator sees the real cause instead of a JSON-parse error.
  try {
    return await activateNbfc(req, ctx);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    console.error("[nbfc/activate] unhandled failure", e);
    return NextResponse.json(
      { ok: false, error: "ACTIVATION_FAILED", message: msg },
      { status: 500 },
    );
  }
}

async function activateNbfc(
  req: NextRequest,
  ctx: { params: Promise<{ nbfcId: string }> },
) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;
  const adminUserId = auth.user.id;

  // Admin-team gate. Activation is now the admin's manual step (was CEO-only
  // before — the user moved this off the CEO so the credential dispatch
  // happens at the admin's pace once both signers complete). CEO retained as
  // a permitted caller so the test_bypass path and any CEO-driven recovery
  // still work.
  const ACTIVATION_ROLES = new Set([
    "admin",
    "sales_head",
    "business_head",
    "ceo",
  ]);
  if (auth.user.via !== "test_bypass") {
    const role = (auth.user.role ?? "").toLowerCase();
    const email = (auth.user.email ?? "").toLowerCase();
    if (!ACTIVATION_ROLES.has(role) && email !== "sanchit@itarang.com") {
      return NextResponse.json(
        {
          ok: false,
          error: "FORBIDDEN",
          message: "Only the admin team or CEO may activate an NBFC.",
        },
        { status: 403 },
      );
    }
  } else if (!ACTIVATION_ROLES.has((auth.user.role ?? "").toLowerCase())) {
    return NextResponse.json(
      {
        ok: false,
        error: "FORBIDDEN",
        message: "Only the admin team or CEO may activate an NBFC.",
      },
      { status: 403 },
    );
  }

  const { nbfcId } = await ctx.params;
  const id = Number.parseInt(nbfcId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { ok: false, error: "Invalid nbfcId" },
      { status: 400 },
    );
  }

  // Tolerant body parse — body is optional.
  let body: unknown = {};
  try {
    const text = await req.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const parsed = ActivateBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "VALIDATION", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const resend = parsed.data.resend === true;

  // Resolve NBFC.
  const [row] = await db
    .select({
      id: nbfc.id,
      nbfc_id: nbfc.nbfc_id,
      legal_name: nbfc.legal_name,
      short_name: nbfc.short_name,
      status: nbfc.status,
      primary_contact_email: nbfc.primary_contact_email,
      primary_contact_name: nbfc.primary_contact_name,
      rbi_registration_no: nbfc.rbi_registration_no,
      grievance_url: nbfc.grievance_url,
      grievance_helpline: nbfc.grievance_helpline,
      lsp_agreement_id: nbfc.lsp_agreement_id,
    })
    .from(nbfc)
    .where(eq(nbfc.id, id))
    .limit(1);

  if (!row) {
    return NextResponse.json(
      { ok: false, error: "NBFC not found" },
      { status: 404 },
    );
  }

  // Idempotent guard: must be approved OR already active+resend.
  const isApproved = row.status === "approved";
  const isActiveResend = row.status === "active" && resend;
  if (!isApproved && !isActiveResend) {
    return NextResponse.json(
      {
        ok: false,
        error: "MUST_BE_APPROVED",
        message: "must be approved before activation",
        status: row.status,
      },
      { status: 409 },
    );
  }

  // Resolve the canonical COMPLETED LSP agreement id once. Prefer the FK the
  // Digio webhook stamps on the NBFC when the agreement completes; fall back to
  // the newest COMPLETED row for legacy data where the FK was never propagated.
  // Reused below for both the NBFC-signer lookup and the welcome-email PDFs.
  let agreementId: number | null = row.lsp_agreement_id ?? null;
  if (!agreementId) {
    const [completed] = await db
      .select({ id: nbfcLspAgreements.id })
      .from(nbfcLspAgreements)
      .where(
        and(
          eq(nbfcLspAgreements.nbfc_id, id),
          eq(nbfcLspAgreements.agreement_status, "COMPLETED"),
        ),
      )
      .orderBy(desc(nbfcLspAgreements.id))
      .limit(1);
    agreementId = completed?.id ?? null;
  }

  // Both signers must have completed before first-time activation. (Skip on
  // resend since the agreement is already terminal in that path.) The
  // nbfc_lsp_agreements table may carry several history rows when an
  // agreement was re-initiated — accept activation as long as at least one
  // row reached COMPLETED, mirroring the lspTerminalRows lookup the
  // /admin/nbfc/[id]/review page uses to drive its UI.
  if (isApproved && !agreementId) {
    return NextResponse.json(
      {
        ok: false,
        error: "AGREEMENT_NOT_COMPLETED",
        message:
          "LSP agreement must be fully signed before the NBFC can be activated.",
      },
      { status: 409 },
    );
  }

  // Portal credentials go to the NBFC-side LSP signer — the authorised NBFC
  // representative who actually signed the agreement — NOT the onboarding
  // primary_contact (which is a comms contact and was frequently a shared
  // test address). The login ID becomes this signer's email. Fall back to
  // primary_contact only when no NBFC-party signer is on file (legacy data).
  let recipientEmail = row.primary_contact_email;
  let recipientName = row.primary_contact_name;
  if (agreementId) {
    const [nbfcSigner] = await db
      .select({
        email: nbfcLspAgreementSigners.email,
        full_name: nbfcLspAgreementSigners.full_name,
      })
      .from(nbfcLspAgreementSigners)
      .where(
        and(
          eq(nbfcLspAgreementSigners.nbfc_lsp_agreement_id, agreementId),
          eq(nbfcLspAgreementSigners.party, "nbfc"),
        ),
      )
      .orderBy(asc(nbfcLspAgreementSigners.signer_order))
      .limit(1);
    if (nbfcSigner?.email) {
      recipientEmail = nbfcSigner.email;
      recipientName = nbfcSigner.full_name ?? recipientName;
    }
  }

  // 2. Generate password first so we can plumb it into Supabase user creation;
  // the email-bound copy must match what Supabase actually accepts.
  const password = generatePortalPassword();

  // 1. Provision (or look up) the Supabase auth user with that exact password.
  let supabaseUserId: string;
  try {
    supabaseUserId = await ensureSupabaseUser(recipientEmail, password);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.json(
      { ok: false, error: "SUPABASE_USER_PROVISION_FAILED", message: msg },
      { status: 500 },
    );
  }

  // Guard the users.email UNIQUE constraint BEFORE any write. The portal login
  // email must not already belong to a DIFFERENT platform user. When it does
  // — e.g. the address was previously onboarded as a dealer with a users row
  // whose id differs from this NBFC's Supabase auth uid — the `users` upsert
  // below (ON CONFLICT (id)) can't absorb the email collision and throws a
  // users_email_key violation mid-activation, leaving the NBFC half-active and
  // leaking a 'pending' nbfc_portal_credentials row each attempt. Fail fast
  // with an actionable message instead. Compare case-insensitively because
  // Supabase lowercases auth emails while users.email is stored as entered.
  const [emailOwner] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${recipientEmail})`)
    .limit(1);
  if (emailOwner && emailOwner.id !== supabaseUserId) {
    return NextResponse.json(
      {
        ok: false,
        error: "EMAIL_ALREADY_IN_USE",
        message:
          `The NBFC signer email ${recipientEmail} is already ` +
          `registered to another account (role: ${emailOwner.role ?? "unknown"}). ` +
          `Use a different email for this NBFC's signer, or remove the ` +
          `conflicting account before activating.`,
      },
      { status: 409 },
    );
  }

  const credentialId = randomUUID();
  await db.insert(nbfcPortalCredentials).values({
    id: credentialId,
    nbfc_id: id,
    supabase_user_id: supabaseUserId,
    dispatch_status: "pending",
  });

  // 3. Flip status to active + stamp activated_at (only when first activating;
  //    on resend we keep status active and just bump activated_at).
  const now = new Date();
  await db
    .update(nbfc)
    .set({
      status: "active",
      activated_at: now,
      updated_at: now,
    })
    .where(eq(nbfc.id, id));

  // 3b. Seed the portal tenancy: nbfc_tenants row + users row + nbfc_users
  //     membership. Without these the supabase user can authenticate but the
  //     /nbfc routes 500 on getCurrentTenant(). All three are upserts so a
  //     resend is safe.
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

  // 3c. Bind the legacy `nbfc` row to its tenant (E-139). The inline
  //     activation above seeds nbfc_tenants but historically never wrote
  //     nbfc.tenant_id back — leaving the NBFC unbound. With a NULL binding
  //     the Section G loader (loadActiveProductsForDealer) filters the NBFC
  //     out of a dealer's financing options, and the submit-product-selection
  //     fan-out can't resolve a tenant so the lead never reaches the NBFC's
  //     Acquire queue. Only fill when NULL so a prior manual binding (E-026B)
  //     is never clobbered.
  await db
    .update(nbfc)
    .set({ tenant_id: tenantId, updated_at: now })
    .where(and(eq(nbfc.id, id), isNull(nbfc.tenant_id)));

  // The middleware reads role from supabase user_metadata first, but the
  // /api/user/profile sync endpoint and various server-side helpers also
  // consult the public.users table. Upsert a row so both code paths agree.
  await db
    .insert(users)
    .values({
      id: supabaseUserId,
      email: recipientEmail,
      name: recipientName,
      role: "nbfc_partner",
      must_change_password: true,
    })
    .onConflictDoUpdate({
      target: users.id,
      set: {
        role: "nbfc_partner",
        must_change_password: true,
        updated_at: now,
      },
    });

  // nbfc_users has no PK on (user_id, tenant_id); guard the duplicate via a
  // raw NOT EXISTS check so a resend doesn't pile up rows.
  // Role must be a canonical origination role (nbfc_users_role_check, §7.2) —
  // 'nbfc_admin' is the account owner. The legacy 'admin' value is NOT in the
  // CHECK set, so seeding it made the row un-updatable (any later UPDATE re-runs
  // the NOT VALID constraint on the new row and fails).
  await db.execute(sql`
    INSERT INTO ${nbfcUsers} (user_id, tenant_id, role)
    SELECT ${supabaseUserId}::uuid, ${tenantId}::uuid, 'nbfc_admin'
    WHERE NOT EXISTS (
      SELECT 1 FROM ${nbfcUsers}
      WHERE user_id = ${supabaseUserId}::uuid AND tenant_id = ${tenantId}::uuid
    )
  `);

  // 4. Resolve the signed LSP agreement + audit-trail PDFs for the same
  //    canonical agreement (agreementId, resolved above) so we can attach them
  //    to the welcome email. PDFs live under public/nbfc-uploads and are served
  //    as static files; we fetch them via the app origin.
  const [latestAgreementPdfs] = agreementId
    ? await db
        .select({
          signed_pdf_url: nbfcLspAgreements.signed_pdf_url,
          audit_trail_url: nbfcLspAgreements.audit_trail_url,
        })
        .from(nbfcLspAgreements)
        .where(eq(nbfcLspAgreements.id, agreementId))
        .limit(1)
    : [undefined];

  const appOrigin = process.env.NEXT_PUBLIC_APP_URL ?? req.nextUrl.origin;
  const toAbsoluteUrl = (u?: string | null): string | null => {
    if (!u) return null;
    return /^https?:\/\//i.test(u) ? u : `${appOrigin}${u}`;
  };

  const [signedAgreementPdf, auditTrailPdf] = await Promise.all([
    downloadPdfBuffer(toAbsoluteUrl(latestAgreementPdfs?.signed_pdf_url)),
    downloadPdfBuffer(toAbsoluteUrl(latestAgreementPdfs?.audit_trail_url)),
  ]);

  const loginUrl = `${appOrigin}/login`;

  // 5. Send welcome email — on failure, revert status to 'approved' and bubble.
  try {
    await enqueueNbfcPortalCredentialsJob({
      nbfcId: id,
      credentialId,
      toEmail: recipientEmail,
      password,
      supabaseUserId,
      primaryContactName: recipientName,
      nbfcLegalName: row.legal_name,
      nbfcCode: row.nbfc_id,
      loginUrl,
      signedAgreementPdf,
      auditTrailPdf,
    });
  } catch (e) {
    // Revert: mark credential row failed and reset NBFC status only when this
    // was the first activation (status was 'approved' before this call).
    await db
      .update(nbfcPortalCredentials)
      .set({ dispatch_status: "credential_dispatch_failed" })
      .where(eq(nbfcPortalCredentials.id, credentialId));
    if (isApproved) {
      await db
        .update(nbfc)
        .set({ status: "approved", activated_at: null, updated_at: new Date() })
        .where(eq(nbfc.id, id));
    }
    const msg = e instanceof Error ? e.message : "unknown";
    return NextResponse.json(
      { ok: false, error: "EMAIL_ENQUEUE_FAILED", message: msg },
      { status: 500 },
    );
  }

  // 5. Mark dispatch as enqueued (email_dispatched_at is set when worker
  //    actually sends — for now we record enqueue timestamp).
  await db
    .update(nbfcPortalCredentials)
    .set({
      dispatch_status: "dispatched",
      email_dispatched_at: new Date(),
    })
    .where(eq(nbfcPortalCredentials.id, credentialId));

  // 6. Audit log.
  await db.insert(auditLogs).values({
    id: randomUUID(),
    entity_type: "nbfc",
    entity_id: String(id),
    action: resend ? "nbfc.credentials_resent" : "nbfc.activated",
    performed_by:
      typeof adminUserId === "string" ? adminUserId : String(adminUserId),
    new_data: {
      status: "active",
      activated_at: now.toISOString(),
      credentialId,
      credentialDispatchedTo: maskEmail(recipientEmail),
    },
  });

  return NextResponse.json({
    ok: true,
    nbfcId: id,
    status: "active",
    credentialDispatchedTo: maskEmail(recipientEmail),
  });
}
