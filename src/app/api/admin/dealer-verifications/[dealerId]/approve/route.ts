import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dealerOnboardingApplications, users, accounts } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { generateTemporaryPassword } from "@/lib/auth/generateTemporaryPassword";
import { hashPassword } from "@/lib/auth/hashPassword";
import { sendDealerWelcomeEmail } from "@/lib/email/sendDealerWelcomeEmail";
import { sendDealerApprovalNotificationEmail } from "@/lib/email/sendDealerApprovalNotificationEmail";
import { getDealerNotificationRecipients } from "@/lib/email/dealer-notification-recipients";
import { downloadPdfBuffer } from "@/lib/email/downloadPdfBuffer";
import { ensureDealerAuditTrailUrl } from "@/lib/digio/ensure-audit-trail";
import { ensureDealerSignedAgreementUrl } from "@/lib/digio/ensure-signed-agreement";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { requireSalesHead } from "@/lib/auth/requireSalesHead";
import { classifyGstinConflict } from "@/lib/dealer/duplicate-check";

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

function resolveDealerLoginEmail(application: any) {
  return application?.ownerEmail?.trim?.() || null;
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

    if (application.onboardingStatus === "approved") {
      return NextResponse.json(
        { success: false, message: "Dealer already approved" },
        { status: 400 }
      );
    }

    if (application.onboardingStatus !== "submitted") {
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

    if (application.financeEnabled) {
      if (
        application.agreementStatus !== "completed" ||
        application.reviewStatus !== "agreement_completed" ||
        !application.providerDocumentId
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

    const isBranchDealer = classification.conflict === "branch";
    const sharedAccountId =
      isBranchDealer && classification.existing
        ? classification.existing.dealerCode
        : null;

    // For branch approvals, adopt the existing account's id as this dealer's
    // code so all downstream FK-style linkage (users.dealer_id, leads, etc.)
    // points at the shared legal entity.
    const dealerCode =
      sharedAccountId || application.dealerCode || generateDealerCode();

    // Pre-flight: for finance-enabled dealers, guarantee BOTH the signed
    // agreement PDF and the audit trail PDF are available before we create
    // any auth user or touch the DB. If either is unavailable, hard-block
    // with 409 so the admin retries instead of a dealer being activated
    // with an empty welcome email.
    let signedAgreementPdf: Buffer | null = null;
    let auditTrailPdf: Buffer | null = null;

    if (application.financeEnabled) {
      const [signedUrl, auditUrl] = await Promise.all([
        ensureDealerSignedAgreementUrl(application).catch((err) => {
          console.error("ENSURE SIGNED AGREEMENT ERROR:", err);
          return null;
        }),
        ensureDealerAuditTrailUrl(application).catch((err) => {
          console.error("ENSURE AUDIT TRAIL ERROR:", err);
          return null;
        }),
      ]);

      const [signedBuf, auditBuf] = await Promise.all([
        downloadPdfBuffer(signedUrl),
        downloadPdfBuffer(auditUrl),
      ]);

      if (!signedBuf || !auditBuf) {
        console.warn("APPROVE BLOCKED — agreement PDFs not ready", {
          applicationId: application.id,
          hasSignedUrl: Boolean(signedUrl),
          hasAuditUrl: Boolean(auditUrl),
          hasSignedBuf: Boolean(signedBuf),
          hasAuditBuf: Boolean(auditBuf),
        });

        return NextResponse.json(
          {
            success: false,
            message:
              "Agreement PDFs are not ready yet — please retry once signing is fully complete.",
            details: {
              signedAgreementAvailable: Boolean(signedBuf),
              auditTrailAvailable: Boolean(auditBuf),
            },
          },
          { status: 409 }
        );
      }

      signedAgreementPdf = signedBuf;
      auditTrailPdf = auditBuf;
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

    if (existingAuthUser) {
      // Prevent account takeover: only reuse an existing Supabase Auth user if
      // it's already linked to a dealer (role=dealer) AND to THIS dealer code.
      // Without this check, anyone who edits ownerEmail to a non-dealer user's
      // address could force a password reset on that account.
      const meta = (existingAuthUser.user_metadata || {}) as Record<string, unknown>;
      const metaRole = typeof meta.role === "string" ? meta.role : null;
      const metaDealerCode =
        typeof meta.dealer_code === "string" ? meta.dealer_code : null;
      const existingAppDealerUserId = application.dealerUserId || null;

      const isThisDealer =
        metaRole === "dealer" &&
        (metaDealerCode === dealerCode ||
          existingAuthUser.id === existingAppDealerUserId);

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
          dealerUserId: authUserId,
          onboardingStatus: "approved",
          reviewStatus: "approved",
          dealerAccountStatus: "active",
          completionStatus: "completed",
          approvedAt: new Date(),
          signedAt:
            application.agreementStatus === "completed"
              ? application.signedAt || new Date()
              : application.signedAt || null,
          rejectedAt: null,
          rejectionReason: null,
          correctionRemarks: null,
          rejectionRemarks: null,
          dealerCode,
          isBranchDealer,
          updatedAt: new Date(),
        })
        .where(eq(dealerOnboardingApplications.id, dealerId));

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
        const addressObj = typeof application.businessAddress === "object" && application.businessAddress
          ? application.businessAddress as Record<string, any>
          : null;

        await tx.insert(accounts).values({
          id: dealerCode,
          business_entity_name: application.companyName || "Dealer Business",
          gstin: application.gstNumber || "PENDING",
          pan: application.panNumber || null,
          dealer_code: dealerCode,
          contact_name: application.ownerName || application.companyName || "Dealer",
          contact_email: dealerLoginEmail,
          contact_phone: application.ownerPhone || null,
          address_line1: addressObj?.address || addressObj?.line1 || null,
          city: addressObj?.city || null,
          state: addressObj?.state || null,
          pincode: addressObj?.pincode || null,
          bank_name: application.bankName || null,
          bank_account_number: application.accountNumber || null,
          ifsc_code: application.ifscCode || null,
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
            name: application.ownerName || application.companyName || "Dealer",
            role: "dealer",
            dealer_id: dealerCode,
            phone: application.ownerPhone || null,
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
          name: application.ownerName || application.companyName || "Dealer",
          role: "dealer",
          dealer_id: dealerCode,
          phone: application.ownerPhone || null,
          avatar_url: null,
          password_hash: passwordHash,
          must_change_password: true,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        });
      }
    });

    let emailSent = false;
    let emailError: string | null = null;

    // Dealer gets the welcome email with credentials, not this one — includeDealer: false.
    const notificationRecipients = await getDealerNotificationRecipients(application, {
      includeDealer: false,
    });

    console.log("APPROVE MAIL DEBUG:", {
      applicationId: application.id,
      companyName: application.companyName,
      salesManagerEmail: application.salesManagerEmail,
      itarangSignatory1Email: application.itarangSignatory1Email,
      itarangSignatory2Email: application.itarangSignatory2Email,
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
          companyName: application.companyName || "Unknown Company",
          dealerCode,
          dealerName:
            application.ownerName || application.companyName || "Dealer",
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
        dealerName: application.ownerName || application.companyName || "Dealer",
        companyName: application.companyName || "iTarang Dealer",
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
      console.error("DEALER WELCOME EMAIL ERROR:", mailError);
    }

    console.log("DEALER APPROVED:", {
      dealerId,
      dealerCode,
      authUserId,
      email: dealerLoginEmail,
      approvedAt: new Date().toISOString(),
      notificationRecipients,
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