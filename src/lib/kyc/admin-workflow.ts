import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  adminVerificationQueue,
  consentRecords,
  couponCodes,
  facilitationPayments,
  kycVerificationMetadata,
  users,
} from "@/lib/db/schema";
import { createClient } from "@/lib/supabase/server";

export const ADMIN_KYC_OPEN_STATUSES = [
  "pending_itarang_verification",
  "in_progress",
  "requested_correction",
  "requested_more_info",
] as const;

export const ADMIN_KYC_TERMINAL_STATUSES = [
  "approved",
  "rejected",
  "cancelled",
] as const;

export const ADMIN_KYC_SUMMARY_STATUSES = [
  "pending_itarang_verification",
  "in_progress",
  "requested_correction",
  "rejected",
  "approved",
] as const;

export type AdminKycQueueStatus =
  | (typeof ADMIN_KYC_OPEN_STATUSES)[number]
  | (typeof ADMIN_KYC_TERMINAL_STATUSES)[number];

export type AdminKycPriority = "high" | "medium" | "normal";
export type AdminKycCaseType = "loan" | "cash";

export type AppUser = {
  id: string;
  role: string;
  name: string | null;
  email: string | null;
  dealer_id: string | null;
};

const ADMIN_ROLES = new Set(["admin", "ceo", "business_head", "sales_head", "sales_manager", "sales_executive"]);
const DEALER_ROLES = new Set(["dealer"]);
const CONSENT_COMPLETE_STATUSES = new Set([
  "verified",
  "digitally_signed",
  "manual_uploaded",
]);

export function createWorkflowId(prefix: string, now = new Date()): string {
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, "");
  const seq = Math.floor(Math.random() * 10000)
    .toString()
    .padStart(4, "0");

  return `${prefix}-${dateStr}-${seq}`;
}

export async function getAuthenticatedAppUser(): Promise<AppUser | null> {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return null;

  const rows = await db
    .select({
      id: users.id,
      role: users.role,
      name: users.name,
      email: users.email,
      dealer_id: users.dealer_id,
    })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);

  if (rows.length > 0) {
    return rows[0];
  }

  if (!user.email) return null;

  const fallbackRows = await db
    .select({
      id: users.id,
      role: users.role,
      name: users.name,
      email: users.email,
      dealer_id: users.dealer_id,
    })
    .from(users)
    .where(eq(users.email, user.email))
    .limit(1);

  return fallbackRows[0] ?? null;
}

export async function requireAdminAppUser(): Promise<AppUser | null> {
  const appUser = await getAuthenticatedAppUser();
  if (!appUser || !ADMIN_ROLES.has(appUser.role)) return null;
  return appUser;
}

export async function requireDealerAppUser(): Promise<AppUser | null> {
  const appUser = await getAuthenticatedAppUser();
  if (!appUser || !DEALER_ROLES.has(appUser.role)) return null;
  return appUser;
}

export async function isDealerKycEditsLocked(
  leadId: string,
): Promise<boolean> {
  const rows = await db
    .select({ dealer_edits_locked: kycVerificationMetadata.dealer_edits_locked })
    .from(kycVerificationMetadata)
    .where(eq(kycVerificationMetadata.lead_id, leadId))
    .limit(1);

  return rows[0]?.dealer_edits_locked ?? false;
}

export function buildDealerEditLockMessage(): string {
  return "This KYC case has already been submitted for iTarang verification. Dealer edits are locked.";
}

export async function getReservedCouponForLead(leadId: string): Promise<{
  couponCode: string | null;
  couponStatus: string | null;
  paymentMethod: string | null;
}> {
  const [couponRows, paymentRows] = await Promise.all([
    db
      .select({
        couponCode: couponCodes.code,
        couponStatus: couponCodes.status,
      })
      .from(couponCodes)
      .where(eq(couponCodes.used_by_lead_id, leadId))
      .orderBy(desc(couponCodes.validated_at), desc(couponCodes.created_at))
      .limit(1),
    db
      .select({
        couponCode: facilitationPayments.coupon_code,
        paymentMethod: facilitationPayments.payment_method,
      })
      .from(facilitationPayments)
      .where(eq(facilitationPayments.lead_id, leadId))
      .orderBy(desc(facilitationPayments.created_at))
      .limit(1),
  ]);

  const couponRow = couponRows[0];
  const paymentRow = paymentRows[0];

  return {
    couponCode: couponRow?.couponCode ?? paymentRow?.couponCode ?? null,
    couponStatus: couponRow?.couponStatus ?? null,
    paymentMethod: paymentRow?.paymentMethod ?? null,
  };
}

export async function isConsentCompleted(leadId: string): Promise<boolean> {
  const consentRows = await db
    .select({ consent_status: consentRecords.consent_status })
    .from(consentRecords)
    .where(eq(consentRecords.lead_id, leadId))
    .orderBy(
      desc(consentRecords.verified_at),
      desc(consentRecords.signed_at),
      desc(consentRecords.created_at),
    )
    .limit(1);

  const consentStatus = consentRows[0]?.consent_status ?? null;
  return consentStatus ? CONSENT_COMPLETE_STATUSES.has(consentStatus) : false;
}

export function determineCaseType(params: {
  paymentMethod: string | null;
  documentsCount: number;
}): AdminKycCaseType {
  const paymentMethod = params.paymentMethod?.toLowerCase().trim() ?? "";

  if (["finance", "other_finance", "dealer_finance"].includes(paymentMethod)) {
    return "loan";
  }

  return params.documentsCount > 3 ? "loan" : "cash";
}

export function requiredDocumentCount(caseType: AdminKycCaseType): number {
  return caseType === "loan" ? 11 : 3;
}

export function calculateQueuePriority(input: {
  createdAt: Date;
  status: string;
}): AdminKycPriority {
  const ageHours =
    (Date.now() - new Date(input.createdAt).getTime()) / (1000 * 60 * 60);

  if (
    ["requested_correction", "rejected", "approved"].includes(input.status) &&
    ageHours > 12
  ) {
    return "high";
  }

  if (
    ["requested_correction", "rejected", "approved"].includes(input.status) &&
    ageHours > 10
  ) {
    return "medium";
  }

  return "normal";
}

export function formatSlaAge(createdAt: Date): string {
  const elapsedMs = Date.now() - new Date(createdAt).getTime();
  const totalMinutes = Math.max(0, Math.floor(elapsedMs / (1000 * 60)));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${hours}h ${minutes.toString().padStart(2, "0")}m`;
}

export async function getOpenQueueEntryForLead(leadId: string) {
  const rows = await db
    .select()
    .from(adminVerificationQueue)
    .where(
      and(
        eq(adminVerificationQueue.lead_id, leadId),
        inArray(
          adminVerificationQueue.status,
          ADMIN_KYC_OPEN_STATUSES as unknown as string[],
        ),
      ),
    )
    .orderBy(desc(adminVerificationQueue.created_at))
    .limit(1);

  return rows[0] ?? null;
}
