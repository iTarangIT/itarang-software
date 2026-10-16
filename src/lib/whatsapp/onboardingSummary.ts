// The stage tally of Admin → WhatsApp onboarding (the Live tab's stat strip
// and tab badge): every WhatsApp-sourced application, by stage and contact
// type, and how many are "still in progress" (not approved, rejected or
// submitted). Lifted out of /api/admin/whatsapp-onboarding/conversations so
// the menu count (ID 90, /api/admin/nav-counts) reads the very same number.

import { eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "@/lib/db/index";
import { dealerOnboardingApplications, whatsappOnboardingSessions } from "@/lib/db/schema";
import { contactTypeOf, stageOf, type WaStage } from "@/lib/whatsapp/stage";

const dealerSession = alias(whatsappOnboardingSessions, "dealer_session");
const operatorSession = alias(whatsappOnboardingSessions, "operator_session");

export type WhatsAppOnboardingSummary = {
  total: number;
  inProgress: number;
  byStage: Record<WaStage, number>;
  byType: Record<string, number>;
};

/** Unfiltered (no search, no stage) — so it doesn't move as the admin types. */
export async function whatsappOnboardingSummary(): Promise<WhatsAppOnboardingSummary> {
  const summaryRows = await db
    .select({
      onboardingStatus: dealerOnboardingApplications.onboarding_status,
      companyType: dealerOnboardingApplications.company_type,
      currentState: dealerSession.current_state,
      operatorState: operatorSession.current_state,
      flow: sql<string | null>`dealer_session.context->>'flow'`,
    })
    .from(dealerOnboardingApplications)
    .leftJoin(dealerSession, eq(dealerSession.id, dealerOnboardingApplications.wa_session_id))
    .leftJoin(operatorSession, eq(operatorSession.id, dealerOnboardingApplications.wa_operator_session_id))
    .where(eq(dealerOnboardingApplications.source, "whatsapp"));

  const byStage = {} as Record<WaStage, number>;
  const byType = {} as Record<string, number>;
  let inProgress = 0;
  for (const r of summaryRows) {
    const state = r.currentState ?? r.operatorState ?? null;
    const s = stageOf({
      currentState: state,
      onboardingStatus: r.onboardingStatus,
    });
    byStage[s] = (byStage[s] ?? 0) + 1;
    const t = contactTypeOf({
      currentState: state,
      flow: r.flow,
      companyType: r.companyType,
      onboardingStatus: r.onboardingStatus,
    });
    byType[t] = (byType[t] ?? 0) + 1;
    if (s !== "approved" && s !== "rejected" && s !== "submitted") inProgress++;
  }
  return { total: summaryRows.length, inProgress, byStage, byType };
}
