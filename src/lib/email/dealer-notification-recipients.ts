import { db } from "@/lib/db";
import { dealerAgreementSigners } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

function cleanEmail(value: unknown) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Build the notification recipient list for a dealer onboarding action
 * (approve / reject / request-correction).
 *
 * Reads signer emails from BOTH the dealerOnboardingApplications columns
 * (which may be NULL for admin-initiated agreements) AND the
 * dealerAgreementSigners table (which is populated at agreement initiation).
 *
 * This guarantees itarang signers are included even when the application-
 * level columns were never written.
 */
export async function getDealerNotificationRecipients(
  application: any,
  options?: { includeDealer?: boolean },
): Promise<string[]> {
  const includeDealer = options?.includeDealer ?? false;

  const emails: string[] = [];

  if (includeDealer) {
    emails.push(cleanEmail(application?.ownerEmail));
  }

  // Application-level columns (populated by dealer-portal onboarding submit).
  emails.push(cleanEmail(application?.salesManagerEmail));
  emails.push(cleanEmail(application?.itarangSignatory1Email));
  emails.push(cleanEmail(application?.itarangSignatory2Email));

  // Fallback: read itarang signer emails from dealer_agreement_signers.
  // This covers admin-initiated agreements where the app-level columns are NULL
  // but the signer rows were created at agreement initiation.
  try {
    const signers = await db
      .select({
        role: dealerAgreementSigners.signerRole,
        email: dealerAgreementSigners.signerEmail,
      })
      .from(dealerAgreementSigners)
      .where(eq(dealerAgreementSigners.applicationId, application.id));

    for (const s of signers) {
      const role = String(s.role || "").toLowerCase();
      // Skip the dealer signer — they're the dealer owner, already handled by
      // the dedicated welcome email (approval) or by includeDealer (correction/rejection).
      if (role === "dealer") continue;
      emails.push(cleanEmail(s.email));
    }
  } catch (err) {
    console.warn(
      "[DealerNotifications] failed to read dealer_agreement_signers fallback:",
      err,
    );
  }

  return Array.from(new Set(emails.filter(Boolean)));
}
