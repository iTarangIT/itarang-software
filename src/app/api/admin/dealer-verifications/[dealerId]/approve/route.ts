import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications, users, accounts, dealers } from "@/lib/db/schema";
import { and, eq, ne, sql } from "drizzle-orm";
import { generateTemporaryPassword } from "@/lib/auth/generateTemporaryPassword";
import { hashPassword } from "@/lib/auth/hashPassword";
import { sendDealerWelcomeEmail } from "@/lib/email/sendDealerWelcomeEmail";
import { sendDealerApprovalNotificationEmail } from "@/lib/email/sendDealerApprovalNotificationEmail";
import { notifyOnboardingDecision } from "@/lib/notifications/events";
import { getDealerNotificationRecipients } from "@/lib/email/dealer-notification-recipients";
import { downloadPdfBuffer } from "@/lib/email/downloadPdfBuffer";
import { ensureDealerAuditTrailUrl } from "@/lib/digio/ensure-audit-trail";
import { ensureDealerSignedAgreementUrl } from "@/lib/digio/ensure-signed-agreement";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { classifyGstinConflict } from "@/lib/dealer/duplicate-check";
import { usesManualAgreement } from "@/lib/dealer/dealer-capabilities";
import {
  maskPhone,
  sendDealerWelcomeWhatsApp,
  sendOperatorApprovalConfirmationWhatsApp,
  type WhatsAppDelivery,
} from "@/lib/whatsapp/notifications";
import { bindDealerSession } from "@/lib/whatsapp/operator-handoff";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

function generateDealerCode() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  // Wider random suffix (6 hex = ~16M space) — the prior 3-digit space
  // collided across approval retries on the same day.
  const random = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `ACC-ITARANG-${yyyy}${mm}${dd}-${random}`;
}

/**
 * Guards the narrow varchar columns on `accounts` that the approval
 * transaction writes verbatim from the onboarding record. Returns a list of
 * human-readable problems ("" when everything fits).
 *
 * These are NOT re-derivable from the application row's own column types —
 * dealer_onboarding_applications stores them wider (or as text), so an
 * over-long value is only rejected at the moment we copy it across.
 */
function validateAccountFields(application: any): string[] {
  const problems: string[] = [];

  const addressObj =
    typeof application.business_address === "object" &&
    application.business_address
      ? (application.business_address as Record<string, any>)
      : null;

  const ifsc =
    typeof application.ifsc_code === "string"
      ? application.ifsc_code.trim().toUpperCase()
      : "";
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    problems.push(
      `Bank IFSC "${application.ifsc_code}" is invalid (${ifsc.length} characters) — an IFSC is exactly 11: 4 letters, then 0, then 6 letters/digits (e.g. HDFC0000516).`
    );
  }

  const gstin =
    typeof application.gst_number === "string"
      ? application.gst_number.trim()
      : "";
  if (gstin && gstin.length > 15) {
    problems.push(
      `GSTIN "${gstin}" is ${gstin.length} characters — a GSTIN is exactly 15.`
    );
  }

  const pan =
    typeof application.pan_number === "string"
      ? application.pan_number.trim()
      : "";
  if (pan && pan.length > 10) {
    problems.push(
      `PAN "${pan}" is ${pan.length} characters — a PAN is exactly 10.`
    );
  }

  const pincode =
    typeof addressObj?.pincode === "string" ? addressObj.pincode.trim() : "";
  if (pincode && pincode.length > 6) {
    problems.push(
      `Business address PIN code "${pincode}" is ${pincode.length} digits — a PIN code is 6.`
    );
  }

  const phone =
    typeof application.owner_phone === "string"
      ? application.owner_phone.trim()
      : "";
  if (phone && phone.length > 20) {
    problems.push(`Owner phone "${phone}" is longer than 20 characters.`);
  }

  return problems;
}

function resolveDealerLoginEmail(application: any) {
  // Drizzle returns snake_case keys after the schema rename in 10af73a; keep
  // the camelCase fallback so older code paths that still build the row by
  // hand don't break.
  const email = application?.owner_email ?? application?.ownerEmail;
  return typeof email === "string" ? email.trim() || null : null;
}

function resolveDealerLoginUrl(req: NextRequest): string {
  // Explicit single-URL override (local dev / ad-hoc overrides) wins.
  if (process.env.DEALER_LOGIN_URL) return process.env.DEALER_LOGIN_URL;

  const appEnv = (process.env.APP_ENV || process.env.NEXT_PUBLIC_APP_ENV || "").toLowerCase();
  const isProduction =
    appEnv === "production" ||
    (appEnv === "" && process.env.NODE_ENV === "production");

  if (isProduction && process.env.DEALER_LOGIN_URL_PRODUCTION) {
    return process.env.DEALER_LOGIN_URL_PRODUCTION;
  }
  if (!isProduction && process.env.DEALER_LOGIN_URL_SANDBOX) {
    return process.env.DEALER_LOGIN_URL_SANDBOX;
  }

  // Last resort: derive from the request origin (respects proxies).
  const forwardedProto = req.headers.get("x-forwarded-proto");
  const forwardedHost = req.headers.get("x-forwarded-host");
  const requestOrigin = forwardedHost
    ? `${forwardedProto || "https"}://${forwardedHost}`
    : req.nextUrl.origin;
  return `${requestOrigin}/login`;
}


export async function POST(req: NextRequest, context: RouteContext) {
  const auth = await requireSalesHead();
  if (!auth.ok) return auth.response;
  try {
    const { dealerId } = await context.params;

    // The approve button historically sent no body; parse defensively so a
    // bodyless POST still works and simply counts as "not acknowledged".
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const acknowledgeBranch = body?.acknowledgeBranch === true;

    // TEST-ONLY: developer "Direct Approve" path. When true, skip the Digio
    // agreement/signing gates (finance gate + signed-PDF pre-flight) so a
    // finance dealer can be approved without going through initiate → sign →
    // refresh. Everything else (credentials, DB writes, welcome email/WhatsApp)
    // runs identically. Absent/false → byte-for-byte the normal production flow.
    const devBypassAgreement = body?.devBypassAgreement === true;

    const resolvedLoginUrl = resolveDealerLoginUrl(req);

    const existing = await db
      .select()
      .from(dealerOnboardingApplications)
      .where(eq(dealerOnboardingApplications.id, dealerId));

    const application = existing[0];

    if (!application) {
      return NextResponse.json(
        { success: false, message: "Dealer onboarding application not found" },
        { status: 404 }
      );
    }

    if (application.onboarding_status === "approved") {
      return NextResponse.json(
        { success: false, message: "Dealer already approved" },
        { status: 400 }
      );
    }

    if (application.onboarding_status !== "submitted") {
      return NextResponse.json(
        {
          success: false,
          message: "Dealer onboarding must be submitted before approval.",
        },
        { status: 400 }
      );
    }

    const dealerLoginEmail = resolveDealerLoginEmail(application);

    if (!dealerLoginEmail) {
      return NextResponse.json(
        {
          success: false,
          message: "Dealer owner email is missing in onboarding record.",
        },
        { status: 400 }
      );
    }

    // E-225 — this gate is an E-SIGN gate, and two of its three conditions are
    // unsatisfiable for a manual-mode dealer: `provider_document_id` only ever
    // exists for a Digio document, and scrap / new+scrap dealers never reach
    // Digio. Applying it to them would make approval impossible rather than
    // conditional.
    //
    // Per the product decision, a missing paper agreement WARNS rather than
    // blocks (the same treatment E-223 gives the scrap-vendor agreement): the
    // review page shows "no signed agreement on file" on the approve action,
    // and the admin decides. Approving without one is a deliberate,
    // attributable choice, not an oversight the system failed to catch.
    //
    // The gate is unchanged for 'new' dealers — a finance-enabled new-battery
    // dealer still cannot be approved without a completed, e-signed agreement.
    const agreementGateApplies =
      application.finance_enabled &&
      !devBypassAgreement &&
      !usesManualAgreement(application.dealer_type);

    if (agreementGateApplies) {
      if (
        application.agreement_status !== "completed" ||
        application.review_status !== "agreement_completed" ||
        !application.provider_document_id
      ) {
        return NextResponse.json(
          {
            success: false,
            message:
              "Finance-enabled dealers cannot be approved until the agreement is completed.",
          },
          { status: 400 }
        );
      }
    }

    // Pre-flight the fields that get copied verbatim into `accounts`, whose
    // columns are narrow varchars (gstin 15, pan 10, pincode 6, ifsc_code 11,
    // contact_phone 20). WhatsApp-onboarded dealers have these OCR-extracted
    // from document photos, so a stray digit is common — and without this
    // check the only symptom is a 500 with a raw "value too long for type
    // character varying(N)" halfway through the approval transaction, which
    // names no field. Fail early and say exactly what to fix.
    const accountFieldProblems = validateAccountFields(application);

    if (accountFieldProblems.length > 0) {
      return NextResponse.json(
        {
          success: false,
          message: `Cannot approve — fix these details in the dealer record first: ${accountFieldProblems.join(
            " "
          )}`,
          fieldErrors: accountFieldProblems,
        },
        { status: 400 }
      );
    }

    // GSTIN duplicate detection. We classify BEFORE any auth-user work so a
    // hard block doesn't leave a Supabase Auth user orphaned.
    //   - duplicate / pan-mismatch → 409, stop here.
    //   - branch → reuse the existing accounts row (skip insert below),
    //     override dealerCode to the shared account's id, mark application
    //     as a branch so admin PATCH can enforce read-only on shared fields.
    //   - none → insert a new accounts row as today.
    const classification = await classifyGstinConflict(application);

    if (
      classification.conflict === "duplicate" ||
      classification.conflict === "pan-mismatch"
    ) {
      return NextResponse.json(
        {
          success: false,
          message: classification.message,
          conflict: classification.conflict,
          existing: classification.existing,
        },
        { status: 409 }
      );
    }

    // Branch linkage is silent from the admin's POV otherwise: the dealer gets
    // NO accounts row of its own, so it never appears in the inventory dealer
    // dropdowns — it lives under the parent entity. Require the admin to
    // explicitly acknowledge that before approving.
    if (classification.conflict === "branch" && !acknowledgeBranch) {
      return NextResponse.json(
        {
          success: false,
          conflict: "branch",
          requiresBranchAcknowledgement: true,
          existing: classification.existing,
          message:
            classification.message ||
            "This GSTIN already belongs to an existing dealer account. Confirm the branch linkage before approving.",
        },
        { status: 409 }
      );
    }

    const isBranchDealer = classification.conflict === "branch";
    const sharedAccountId =
      isBranchDealer && classification.existing
        ? classification.existing.dealerCode
        : null;

    // For branch approvals, adopt the existing account's id as this dealer's
    // code so all downstream FK-style linkage (users.dealer_id, leads, etc.)
    // points at the shared legal entity.
    //
    // A dealer_code left over from a PREVIOUS branch approval is the parent's
    // id, not this dealer's. If the application is no longer classified as a
    // branch (e.g. GSTIN corrected after a request-correction cycle), reusing
    // it would silently keep the wrong linkage — generate a fresh code instead.
    const staleBranchCode =
      Boolean(application.is_branch_dealer) && !isBranchDealer;
    const dealerCode =
      sharedAccountId ||
      (staleBranchCode ? null : application.dealer_code) ||
      generateDealerCode();

    // Pre-flight: for finance-enabled dealers, guarantee BOTH the signed
    // agreement PDF and the audit trail PDF are available before we create
    // any auth user or touch the DB. If either is unavailable, hard-block
    // with 409 so the admin retries instead of a dealer being activated
    // with an empty welcome email.
    let signedAgreementPdf: Buffer | null = null;
    let auditTrailPdf: Buffer | null = null;
    // Public Supabase URLs (cached by the ensure* helpers) — kept in outer
    // scope so the WhatsApp welcome can attach them as document messages after
    // the email send below.
    let signedAgreementUrl: string | null = null;
    let auditTrailUrl: string | null = null;

    // E-225 — manual-mode dealers are included in the FETCH (an uploaded paper
    // agreement should still reach the welcome email) but excluded from the
    // hard block below, per the same warn-don't-block decision as the status
    // gate above. A scrap dealer with finance off gets here too, which is the
    // point: their agreement is not a finance agreement.
    const isManualAgreement = usesManualAgreement(application.dealer_type);

    if ((application.finance_enabled || isManualAgreement) && !devBypassAgreement) {
      const [signedUrl, auditUrl] = await Promise.all([
        ensureDealerSignedAgreementUrl(application).catch((err) => {
          console.error("ENSURE SIGNED AGREEMENT ERROR:", err);
          return null;
        }),
        // Digio-only artefact; a paper agreement has none, so don't go asking.
        isManualAgreement
          ? Promise.resolve(null)
          : ensureDealerAuditTrailUrl(application).catch((err) => {
              console.error("ENSURE AUDIT TRAIL ERROR:", err);
              return null;
            }),
      ]);

      const [signedBuf, auditBuf] = await Promise.all([
        downloadPdfBuffer(signedUrl),
        downloadPdfBuffer(auditUrl),
      ]);

      // The SIGNED agreement is the essential artifact — it proves signing is
      // complete and is attached to the welcome email/WhatsApp. Block approval
      // only if we can't obtain it.
      //
      // The AUDIT TRAIL is a supplementary compliance doc fetched live from
      // Digio's download_audit_trail endpoint, which is flaky in practice
      // (intermittent HTTP 500 "System error has occurred", even when the doc
      // status is "completed"). A missing audit trail must NOT block dealer
      // activation — it's attached when available and silently omitted
      // otherwise (downloadPdfBuffer already returns null gracefully).
      //
      // A MANUAL-mode dealer is exempt: there may legitimately be no signed
      // copy yet, and the decision is the admin's to make (the review page
      // warns). Their welcome email simply goes out without the attachment
      // rather than approval failing.
      if (!signedBuf && !isManualAgreement) {
        console.warn("APPROVE BLOCKED — signed agreement PDF not ready", {
          applicationId: application.id,
          hasSignedUrl: Boolean(signedUrl),
          hasSignedBuf: Boolean(signedBuf),
        });

        return NextResponse.json(
          {
            success: false,
            message:
              "Signed agreement is not ready yet — please retry once signing is fully complete.",
            details: {
              signedAgreementAvailable: Boolean(signedBuf),
              auditTrailAvailable: Boolean(auditBuf),
            },
          },
          { status: 409 }
        );
      }

      if (!auditBuf) {
        console.warn(
          "APPROVE — audit trail PDF unavailable; proceeding without it",
          {
            applicationId: application.id,
            hasAuditUrl: Boolean(auditUrl),
          }
        );
      }

      signedAgreementPdf = signedBuf;
      auditTrailPdf = auditBuf;
      signedAgreementUrl = signedUrl;
      auditTrailUrl = auditUrl;
    }

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    const { data: authUsers, error: listError } =
      await supabaseAdmin.auth.admin.listUsers();

    if (listError) {
      console.error("SUPABASE AUTH LIST USERS ERROR:", listError);
      return NextResponse.json(
        {
          success: false,
          message: `Failed to list auth users: ${listError.message}`,
        },
        { status: 500 }
      );
    }

    const existingAuthUser = authUsers?.users?.find(
      (u) => u.email?.toLowerCase() === dealerLoginEmail.toLowerCase()
    );

    let authUserId: string;
    // Tracks whether THIS request minted the auth user. If the DB transaction
    // below then fails, we delete it again — an auth user is not covered by
    // the pg rollback, and leaving one behind wedges every future retry on the
    // "email already exists" gate above.
    let createdAuthUserInThisRequest = false;

    if (existingAuthUser) {
      // Prevent account takeover: only reuse an existing Supabase Auth user if
      // it's already linked to a dealer (role=dealer) AND to THIS dealer code.
      // Without this check, anyone who edits ownerEmail to a non-dealer user's
      // address could force a password reset on that account.
      const meta = (existingAuthUser.user_metadata || {}) as Record<string, unknown>;
      const metaRole = typeof meta.role === "string" ? meta.role : null;
      const metaDealerCode =
        typeof meta.dealer_code === "string" ? meta.dealer_code : null;
      const existingAppDealerUserId = application.dealer_user_id || null;

      let isThisDealer =
        metaRole === "dealer" &&
        (metaDealerCode === dealerCode ||
          existingAuthUser.id === existingAppDealerUserId);

      // A previous approve attempt for THIS application can die after the auth
      // user is created but before the DB transaction commits (the auth user
      // lives outside the pg transaction, so a rollback does not remove it).
      // That leaves a role=dealer auth user stamped with a dealer_code that
      // exists nowhere in the DB, while the application still has
      // dealer_code = NULL / dealer_user_id = NULL. Every retry then mints a
      // FRESH random dealer code, so neither branch above can ever match and
      // the admin is permanently locked out with "email already exists".
      //
      // Adopt such an orphan — but only after proving nothing else claims it:
      // no users row (by id or email), no other application, and no
      // accounts/dealers row keyed by its stamped dealer_code. If any claim
      // exists it really is someone else's account and we still hard-block.
      if (!isThisDealer && metaRole === "dealer") {
        const [
          claimedByAuthId,
          claimedByEmail,
          claimedByOtherApp,
          claimedAccount,
          claimedDealer,
        ] = await Promise.all([
          db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.id, existingAuthUser.id))
            .limit(1),
          db
            .select({ id: users.id })
            .from(users)
            .where(sql`lower(${users.email}) = lower(${dealerLoginEmail})`)
            .limit(1),
          db
            .select({ id: dealerOnboardingApplications.id })
            .from(dealerOnboardingApplications)
            .where(
              and(
                eq(
                  dealerOnboardingApplications.dealer_user_id,
                  existingAuthUser.id
                ),
                ne(dealerOnboardingApplications.id, dealerId)
              )
            )
            .limit(1),
          metaDealerCode
            ? db
                .select({ id: accounts.id })
                .from(accounts)
                .where(eq(accounts.id, metaDealerCode))
                .limit(1)
            : Promise.resolve([] as { id: string }[]),
          metaDealerCode
            ? db
                .select({ id: dealers.dealer_id })
                .from(dealers)
                .where(eq(dealers.dealer_id, metaDealerCode))
                .limit(1)
            : Promise.resolve([] as { id: string }[]),
        ]);

        const isOrphan =
          claimedByAuthId.length === 0 &&
          claimedByEmail.length === 0 &&
          claimedByOtherApp.length === 0 &&
          claimedAccount.length === 0 &&
          claimedDealer.length === 0;

        if (isOrphan) {
          console.warn(
            "APPROVE — adopting orphaned auth user left by a failed prior attempt",
            {
              applicationId: application.id,
              authUserId: existingAuthUser.id,
              staleDealerCode: metaDealerCode,
              newDealerCode: dealerCode,
            }
          );
          isThisDealer = true;
        }
      }

      if (!isThisDealer) {
        return NextResponse.json(
          {
            success: false,
            message:
              "An account with this email already exists for a different user. Resolve the email conflict before approving.",
          },
          { status: 409 }
        );
      }

      const { data: updatedAuthUser, error: updateAuthError } =
        await supabaseAdmin.auth.admin.updateUserById(existingAuthUser.id, {
          password: temporaryPassword,
          email_confirm: true,
          user_metadata: {
            role: "dealer",
            dealer_code: dealerCode,
          },
        });

      if (updateAuthError) {
        console.error("SUPABASE AUTH UPDATE ERROR:", updateAuthError);
        return NextResponse.json(
          {
            success: false,
            message: `Failed to update auth user: ${updateAuthError.message}`,
          },
          { status: 500 }
        );
      }

      authUserId = updatedAuthUser.user.id;
    } else {
      const { data: createdAuthUser, error: createAuthError } =
        await supabaseAdmin.auth.admin.createUser({
          email: dealerLoginEmail,
          password: temporaryPassword,
          email_confirm: true,
          user_metadata: {
            role: "dealer",
            dealer_code: dealerCode,
          },
        });

      if (createAuthError) {
        console.error("SUPABASE AUTH CREATE ERROR:", createAuthError);
        return NextResponse.json(
          {
            success: false,
            message: `Failed to create auth user: ${createAuthError.message}`,
          },
          { status: 500 }
        );
      }

      authUserId = createdAuthUser.user.id;
      createdAuthUserInThisRequest = true;
    }

    // Run the local DB side of approval atomically: if any of the three
    // writes fails we roll back so we don't leave an application flipped to
    // "approved" without an accounts row or users row.
    // (Supabase Auth is out of scope for a pg transaction — we handle that
    // sequentially above, then commit the local state.)
    await db.transaction(async (tx) => {
      await tx
        .update(dealerOnboardingApplications)
        .set({
          dealer_user_id: authUserId,
          onboarding_status: "approved",
          review_status: "approved",
          dealer_account_status: "active",
          completion_status: "completed",
          approved_at: new Date(),
          // Who approved — drives the "CEO approved" / "Admin approved" tag.
          approved_by: auth.user.id,
          signed_at:
            application.agreement_status === "completed"
              ? application.signed_at || new Date()
              : application.signed_at || null,
          rejected_at: null,
          rejection_reason: null,
          correction_remarks: null,
          rejection_remarks: null,
          dealer_code: dealerCode,
          is_branch_dealer: isBranchDealer,
          updated_at: new Date(),
        })
        .where(eq(dealerOnboardingApplications.id, dealerId));

      // Canonical dealers row — the E-105 lead-creation gate reads from here
      // (src/app/api/leads/create/route.ts). Without this, an admin-approved
      // dealer hits "DEALER_NOT_ACTIVE / not_onboarded" the moment they try
      // to create a lead. Branch dealers also get their own dealers row
      // keyed by their own dealer_code (unlike accounts, which is shared).
      const financeEnabled = application.finance_enabled ?? false;
      await tx
        .insert(dealers)
        .values({
          dealer_id: dealerCode,
          company_name: application.company_name,
          company_type: application.company_type ?? "individual",
          dealer_type: application.dealer_type ?? null,
          gst_number: application.gst_number ?? null,
          pan_number: application.pan_number ?? null,
          registered_address: application.registered_address ?? null,
          bank_name: application.bank_name ?? null,
          bank_account_number: application.account_number ?? null,
          bank_ifsc: application.ifsc_code ?? null,
          bank_beneficiary: application.beneficiary_name ?? null,
          owner_name: application.owner_name ?? null,
          owner_phone: application.owner_phone ?? null,
          owner_email: application.owner_email ?? null,
          finance_enabled: financeEnabled,
          onboarding_status: "active",
          application_id: application.id,
          activated_at: new Date(),
        })
        .onConflictDoUpdate({
          target: dealers.dealer_id,
          set: {
            onboarding_status: "active",
            finance_enabled: financeEnabled,
            application_id: application.id,
            activated_at: new Date(),
            updated_at: new Date(),
          },
        });

      // If this application was previously branch-linked, its old approval
      // upserted the PARENT-keyed dealers row with this application_id.
      // Detach that residue so the parent row no longer claims this
      // application.
      if (staleBranchCode && application.dealer_code) {
        await tx
          .update(dealers)
          .set({ application_id: null, updated_at: new Date() })
          .where(
            and(
              eq(dealers.dealer_id, application.dealer_code),
              eq(dealers.application_id, application.id)
            )
          );
      }

      // Branch dealers reuse the existing accounts row — skip the insert
      // entirely (a new insert would violate UNIQUE(gstin) + UNIQUE(id)).
      // The user-row insert below still runs so the branch dealer gets
      // their own login.
      if (!isBranchDealer) {
      // Create account row so leads.dealer_id FK is satisfied
      const existingAccount = await tx
        .select()
        .from(accounts)
        .where(eq(accounts.id, dealerCode))
        .limit(1);

      if (existingAccount.length === 0) {
        const addressObj = typeof application.business_address === "object" && application.business_address
          ? application.business_address as Record<string, any>
          : null;

        await tx.insert(accounts).values({
          id: dealerCode,
          business_entity_name: application.company_name || "Dealer Business",
          gstin: application.gst_number || "PENDING",
          pan: application.pan_number || null,
          dealer_code: dealerCode,
          contact_name: application.owner_name || application.company_name || "Dealer",
          contact_email: dealerLoginEmail,
          contact_phone: application.owner_phone || null,
          address_line1: addressObj?.address || addressObj?.line1 || null,
          city: addressObj?.city || null,
          state: addressObj?.state || null,
          pincode: addressObj?.pincode || null,
          bank_name: application.bank_name || null,
          bank_account_number: application.account_number || null,
          ifsc_code: application.ifsc_code?.trim().toUpperCase() || null,
          status: "active",
          onboarding_status: "approved",
          created_by: authUserId,
        });
      }
      } // end: if (!isBranchDealer)

      const existingUserRows = await tx
        .select()
        .from(users)
        .where(eq(users.email, dealerLoginEmail));

      const existingUser = existingUserRows[0];

      if (existingUser) {
        await tx
          .update(users)
          .set({
            id: authUserId,
            name: application.owner_name || application.company_name || "Dealer",
            role: "dealer",
            dealer_id: dealerCode,
            phone: application.owner_phone || null,
            is_active: true,
            password_hash: passwordHash,
            must_change_password: true,
            updated_at: new Date(),
          })
          .where(eq(users.email, dealerLoginEmail));
      } else {
        await tx.insert(users).values({
          id: authUserId,
          email: dealerLoginEmail,
          name: application.owner_name || application.company_name || "Dealer",
          role: "dealer",
          dealer_id: dealerCode,
          phone: application.owner_phone || null,
          avatar_url: null,
          password_hash: passwordHash,
          must_change_password: true,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }
    }).catch(async (txError) => {
      // The pg rollback cannot undo the Supabase Auth user created above.
      // Remove it so the next retry starts clean instead of colliding with
      // its own leftover on the "email already exists" gate.
      if (createdAuthUserInThisRequest) {
        const { error: cleanupError } =
          await supabaseAdmin.auth.admin.deleteUser(authUserId);
        console.error("APPROVE — transaction failed, rolled back auth user", {
          applicationId: application.id,
          authUserId,
          cleanupError: cleanupError?.message || null,
        });
      }
      throw txError;
    });

    let emailSent = false;
    let emailError: string | null = null;

    // Dealer gets the welcome email with credentials, not this one — includeDealer: false.
    const notificationRecipients = await getDealerNotificationRecipients(application, {
      includeDealer: false,
    });

    console.log("APPROVE MAIL DEBUG:", {
      applicationId: application.id,
      companyName: application.company_name,
      salesManagerEmail: application.sales_manager_email,
      itarangSignatory1Email: application.itarang_signatory_1_email,
      itarangSignatory2Email: application.itarang_signatory_2_email,
      notificationRecipients,
    });

    let internalNotificationResult: {
      success: boolean;
      recipients: string[];
      messageId?: string;
      error?: string;
    } = { success: false, recipients: notificationRecipients };

    if (notificationRecipients.length === 0) {
      internalNotificationResult = {
        success: false,
        recipients: [],
        error: "No itarang signer / sales-manager emails on record",
      };
      console.warn(
        "APPROVAL: No internal notification recipients. Sales manager + signatory emails are missing on the application."
      );
    } else {
      try {
        const notifyResult = await sendDealerApprovalNotificationEmail({
          toEmails: notificationRecipients,
          companyName: application.company_name || "Unknown Company",
          dealerCode,
          dealerName:
            application.owner_name || application.company_name || "Dealer",
          approvedAt: new Date().toISOString(),
        });
        internalNotificationResult = {
          success: true,
          recipients: notifyResult.recipients,
          messageId: notifyResult.messageId,
        };
      } catch (notifyErr: any) {
        internalNotificationResult = {
          success: false,
          recipients: notificationRecipients,
          error: notifyErr?.message || "Unknown email error",
        };
        console.error(
          "APPROVAL internal notification email failed:",
          notifyErr?.message || notifyErr
        );
      }
    }

    // signedAgreementPdf + auditTrailPdf were resolved in the pre-flight block
    // above (or left null for non-finance dealers, which is expected).
    let mailResult: Awaited<ReturnType<typeof sendDealerWelcomeEmail>> | null = null;
    try {
      mailResult = await sendDealerWelcomeEmail({
        toEmail: dealerLoginEmail,
        dealerName: application.owner_name || application.company_name || "Dealer",
        companyName: application.company_name || "iTarang Dealer",
        dealerId: dealerCode,
        userId: dealerLoginEmail,
        password: temporaryPassword,
        loginUrl: resolvedLoginUrl,
        supportEmail:
          process.env.DEALER_SUPPORT_EMAIL || "care@itarang.com",
        supportPhone:
          process.env.DEALER_SUPPORT_PHONE || "+91-8076841497",
        signedAgreementPdf,
        auditTrailPdf,
      });

      console.log("DEALER WELCOME EMAIL SUCCESS:", mailResult);
      emailSent = true;
    } catch (mailError: any) {
      emailError = mailError?.message || "Unknown email error";
      console.error("[WELCOME-MAIL][FAILED]", {
        dealerId,
        toEmail: dealerLoginEmail,
        error: mailError?.message || mailError,
        code: mailError?.code,
        command: mailError?.command,
        stack: mailError?.stack,
      });
    }

    // WhatsApp-onboarded dealers also get their welcome + credentials and the
    // agreement PDFs over WhatsApp (their primary channel). Additive — the
    // welcome email above is unchanged. Best-effort: a WhatsApp failure (e.g.
    // the 24h window is closed) must NOT fail an approval that already wrote the
    // dealer/account/auth rows.
    let whatsappDelivery: WhatsAppDelivery | null = null;
    if (
      application.wa_phone &&
      ((application.source || "web").toLowerCase() === "whatsapp" ||
        // E-214: a file an internal operator created or handed off is a WhatsApp
        // dealer regardless of how `source` was stamped.
        ((application.onboarding_channel as string | null) ?? "self") !== "self")
    ) {
      // E-214: bind (or re-point) a session on the DEALER's own number to this
      // approved application BEFORE sending. In operator-upload mode the dealer
      // has no session at all, so without this the welcome message logs against
      // no conversation and the dealer's first "hi" has to fall through to the
      // slower phone-matched console gate.
      let dealerSessionId = application.wa_session_id ?? null;
      try {
        dealerSessionId = await bindDealerSession(
          application.id as string,
          application.wa_phone as string,
          (application.owner_name || application.company_name) as string | null,
        );
      } catch (bindErr) {
        console.error("[approve] dealer session bind failed:", bindErr);
      }

      whatsappDelivery = await sendDealerWelcomeWhatsApp({
        waSessionId: dealerSessionId,
        waPhone: application.wa_phone,
        dealerName: application.owner_name || application.company_name || "Dealer",
        companyName: application.company_name || "iTarang Dealer",
        dealerCode,
        loginId: dealerLoginEmail,
        password: temporaryPassword,
        loginUrl: resolvedLoginUrl,
        supportEmail: process.env.DEALER_SUPPORT_EMAIL || "care@itarang.com",
        supportPhone: process.env.DEALER_SUPPORT_PHONE || "+91-8076841497",
        financeEnabled: Boolean(application.finance_enabled),
        signedAgreementUrl,
        auditTrailUrl,
      });
      console.log("DEALER WELCOME WHATSAPP:", { dealerId, whatsappDelivery });
    }

    // E-214 — confirmation copy to the internal operator who onboarded this
    // dealer, so they know the file closed and can start the next one. It
    // carries NO password: sendOperatorApprovalConfirmationWhatsApp's params
    // type has no such field. Attribution comes from onboarding_operator_id —
    // NEVER from dealer_user_id, which the transaction above just overwrote with
    // the dealer's own Supabase auth id.
    let operatorDelivery: WhatsAppDelivery | null = null;
    if (application.onboarding_operator_id) {
      try {
        const [op] = await db
          .select({
            waPhone: whatsappOperators.wa_phone,
            displayName: whatsappOperators.display_name,
          })
          .from(whatsappOperators)
          .where(
            eq(
              whatsappOperators.id,
              application.onboarding_operator_id as string,
            ),
          )
          .limit(1);
        if (op?.waPhone) {
          operatorDelivery = await sendOperatorApprovalConfirmationWhatsApp({
            waPhone: op.waPhone,
            waSessionId:
              (application.wa_operator_session_id as string | null) ?? null,
            operatorName: op.displayName,
            companyName: application.company_name || "The dealer",
            dealerCode,
            dealerPhoneMasked: maskPhone(application.wa_phone as string | null),
            dealerEmail: dealerLoginEmail,
            financeEnabled: Boolean(application.finance_enabled),
          });
        }
      } catch (opErr) {
        console.error("[approve] operator confirmation failed:", opErr);
      }
    }

    console.log("DEALER APPROVED:", {
      dealerId,
      dealerCode,
      authUserId,
      email: dealerLoginEmail,
      approvedAt: new Date().toISOString(),
      notificationRecipients,
    });

    // In-app row for the new dealer's bell + an audit copy for the admins.
    // Keyed to `dealerCode`, not the application id: dealerCode IS the value
    // written to users.dealer_id just above, and that is what the bell resolves
    // a dealer audience by. The welcome EMAIL already went out, so this sends
    // no second one.
    await notifyOnboardingDecision({
      dealerId: dealerCode,
      businessName: application.company_name || "Your company",
      decision: "approved",
    });

    return NextResponse.json({
      success: true,
      message: emailSent
        ? "Dealer approved successfully and welcome email sent"
        : "Dealer approved successfully, but welcome email failed",
      dealerCode,
      authUserId,
      emailSent,
      emailTarget: dealerLoginEmail,
      emailError,
      internalNotificationResult,
      attachedSignedAgreement: Boolean(mailResult?.attachedSignedAgreement),
      attachedAuditTrail: Boolean(mailResult?.attachedAuditTrail),
      isBranchDealer,
      whatsappDelivery,
      operatorDelivery,
    });
  } catch (error: any) {
    console.error("APPROVE DEALER ERROR:", error);
    if (error?.cause) console.error("APPROVE DEALER ERROR cause:", error.cause);

    // Drizzle wraps postgres-js errors; the underlying error sits on `.cause`.
    const root = error?.cause ?? error;

    // Translate the known unique-constraint violations into user-readable
    // messages. Without this, the admin sees the raw SQL in a toast.
    let friendlyMessage = error?.message || "Approve failed";
    if (root?.code === "23505") {
      const constraint = root?.constraint_name || root?.constraint || "";
      if (constraint === "accounts_gstin_key") {
        friendlyMessage =
          "Another dealer account already exists with this GSTIN. Please refresh and try again — the duplicate check should flag this.";
      } else if (constraint === "accounts_pkey") {
        friendlyMessage =
          "Dealer account id collision. Please retry — a new code will be generated.";
      } else {
        friendlyMessage =
          "A duplicate record exists for this dealer. Please verify GSTIN, PAN, and email.";
      }
    } else if (root?.code === "23502") {
      friendlyMessage =
        "Required dealer account fields are missing. Ensure GSTIN, PAN, and bank details are filled before approving.";
    }

    return NextResponse.json(
      {
        success: false,
        message: friendlyMessage,
        pg: {
          code: root?.code ?? null,
          detail: root?.detail ?? null,
          constraint: root?.constraint_name ?? root?.constraint ?? null,
          column: root?.column_name ?? root?.column ?? null,
          table: root?.table_name ?? root?.table ?? null,
          hint: root?.hint ?? null,
          severity: root?.severity ?? null,
          where: root?.where ?? null,
          // Last-resort dump of all enumerable own keys so we never go blind on diagnosis.
          keys: root && typeof root === "object" ? Object.keys(root) : null,
          rootMessage: root?.message ?? null,
        },
      },
      { status: 500 }
    );
  }
}