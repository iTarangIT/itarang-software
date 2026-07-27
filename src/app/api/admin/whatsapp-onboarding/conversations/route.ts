// GET /api/admin/whatsapp-onboarding/conversations
//
// Every WhatsApp onboarding conversation, from the very first message — including
// someone who has only said "Hi" and uploaded nothing. This is deliberately NOT
// the Dealer Verification queue: that one hides pure drafts on purpose (an admin
// can't approve an unfinished application), which is exactly why an in-progress
// prospect was invisible anywhere in the CRM until they pressed Submit.
//
// The list is driven off `dealer_onboarding_applications`, not off the sessions
// table, and that choice does a lot of work:
//   • an `operator_hub` row (the internal team's menu) has application_id = NULL,
//     so it can never join in and be mistaken for a dealer prospect;
//   • an `operator_file` row surfaces as the DEALER it points at, with the
//     operator shown as an attribution badge rather than a separate row;
//   • one row per file is what an admin actually wants to count.

import { and, desc, eq, ilike, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import { db } from "@/lib/db/index";
import {
  dealerOnboardingApplications,
  dealerOnboardingDocuments,
  whatsappOnboardingSessions,
  whatsappOperators,
} from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { type CompanyType, requiredDocuments } from "@/lib/whatsapp/checklist";
import { prospectDisplayName, isPlaceholderCompany } from "@/lib/whatsapp/labels";
import {
  activityOf,
  contactTypeOf,
  CONTACT_TYPE_LABEL,
  DEALER_ONBOARDING_STATES,
  stageLabel,
  stageOf,
  STAGE_STATE_PREFIX,
  STAGE_STATES,
  TERMINAL_STAGE_STATUS,
  TERMINAL_STATUSES,
  type WaStage,
} from "@/lib/whatsapp/stage";
import type { Ctx } from "@/lib/whatsapp/session-store";

const READ_ROLES = ["admin", "sales_head", "ceo"];

const QuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  q: z.string().trim().max(120).optional(),
  stage: z.string().trim().max(32).optional(),
  type: z.enum(["dealer", "customer", "enquiry", "undecided"]).optional(),
  // Checked = show ONLY approved dealers. Unchecked = hide them, so the list
  // stays focused on people still going through onboarding.
  approvedOnly: z
    .enum(["0", "1", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

const dealerSession = alias(whatsappOnboardingSessions, "dealer_session");
const operatorSession = alias(whatsappOnboardingSessions, "operator_session");

// Newest signal of life across both possible conversations and the application
// itself, so a file an operator is actively filling sorts above a stale one.
const lastActivity = sql<Date>`GREATEST(
  COALESCE(dealer_session.last_inbound_at, 'epoch'::timestamptz),
  COALESCE(operator_session.last_inbound_at, 'epoch'::timestamptz),
  ${dealerOnboardingApplications.updated_at},
  ${dealerOnboardingApplications.created_at}
)`;

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole(READ_ROLES);

  const url = new URL(req.url);
  const { page, limit, q, stage, type, approvedOnly } = QuerySchema.parse(
    Object.fromEntries(url.searchParams),
  );

  // Every WhatsApp conversation, dealers and customers alike — each row carries a
  // contactType so the console can say which is which. (Customers keep the
  // placeholder dealer application minted at first contact; their LEAD record is
  // what the customer-leads tab lists, which is a different view of them.)
  const filters = [eq(dealerOnboardingApplications.source, "whatsapp")];

  filters.push(
    approvedOnly
      ? eq(dealerOnboardingApplications.onboarding_status, "approved")
      : sql`COALESCE(${dealerOnboardingApplications.onboarding_status}, 'draft') <> 'approved'`,
  );

  if (type) {
    const flow = sql`COALESCE(dealer_session.context->>'flow', '')`;
    const liveState = sql`COALESCE(dealer_session.current_state, operator_session.current_state, '')`;
    const dealerStates = sql`${liveState} = ANY(ARRAY[${sql.join(
      DEALER_ONBOARDING_STATES.map((s) => sql`${s}`),
      sql`, `,
    )}])`;
    // Mirrors contactTypeOf() — keep the two in step.
    const looksLikeDealer = sql`(
      COALESCE(${dealerOnboardingApplications.onboarding_status}, 'draft')
        IN ('approved', 'submitted', 'rejected', 'correction_requested')
      OR ${dealerOnboardingApplications.company_type} IS NOT NULL
      OR ${liveState} LIKE 'DC_%'
      OR ${dealerStates}
    )`;
    if (type === "customer") {
      filters.push(sql`${flow} = 'customer'`);
    } else if (type === "dealer") {
      filters.push(sql`${flow} <> 'customer' AND ${looksLikeDealer}`);
    } else if (type === "enquiry") {
      filters.push(
        sql`${flow} <> 'customer' AND NOT ${looksLikeDealer} AND ${liveState} = 'GENERAL_INFO'`,
      );
    } else {
      filters.push(
        sql`${flow} <> 'customer' AND NOT ${looksLikeDealer} AND ${liveState} <> 'GENERAL_INFO'`,
      );
    }
  }
  // Stage is derived, so filtering it has to be translated back into SQL —
  // filtering the mapped rows afterwards would shrink an already-paginated page
  // and report a total that doesn't match what's shown.
  if (stage) {
    const wanted = stage as WaStage;
    const terminalStatus = TERMINAL_STAGE_STATUS[wanted];
    if (terminalStatus) {
      filters.push(
        eq(dealerOnboardingApplications.onboarding_status, terminalStatus),
      );
    } else {
      // Non-terminal stages only apply once no status has taken precedence.
      const liveState = sql`COALESCE(dealer_session.current_state, operator_session.current_state)`;
      const notTerminal = sql`COALESCE(${dealerOnboardingApplications.onboarding_status}, 'draft') NOT IN (${sql.join(
        TERMINAL_STATUSES.map((s) => sql`${s}`),
        sql`, `,
      )})`;
      const prefix = STAGE_STATE_PREFIX[wanted];
      if (prefix) {
        filters.push(and(notTerminal, sql`${liveState} LIKE ${`${prefix}%`}`)!);
      } else {
        const states = STAGE_STATES[wanted] ?? [];
        if (states.length === 0) {
          // "unknown" — a state we have no label for, or none recorded at all.
          const known = [
            ...Object.values(STAGE_STATES).flat(),
          ] as string[];
          filters.push(
            and(
              notTerminal,
              sql`(${liveState} IS NULL OR (${liveState} NOT LIKE 'DC_%' AND ${liveState} NOT LIKE 'OP_%' AND ${liveState} <> ALL(ARRAY[${sql.join(
                known.map((s) => sql`${s}`),
                sql`, `,
              )}])))`,
            )!,
          );
        } else {
          filters.push(
            and(
              notTerminal,
              sql`${liveState} = ANY(ARRAY[${sql.join(
                states.map((s) => sql`${s}`),
                sql`, `,
              )}])`,
            )!,
          );
        }
      }
    }
  }
  if (q) {
    const like = `%${q}%`;
    filters.push(
      or(
        ilike(dealerOnboardingApplications.company_name, like),
        ilike(dealerOnboardingApplications.owner_name, like),
        ilike(dealerOnboardingApplications.gst_number, like),
        ilike(dealerOnboardingApplications.wa_phone, like),
        ilike(dealerSession.wa_contact_name, like),
      )!,
    );
  }
  const where = and(...filters);

  const baseQuery = db
    .select({
      applicationId: dealerOnboardingApplications.id,
      companyName: dealerOnboardingApplications.company_name,
      companyType: dealerOnboardingApplications.company_type,
      dealerType: dealerOnboardingApplications.dealer_type,
      ownerName: dealerOnboardingApplications.owner_name,
      ownerPhone: dealerOnboardingApplications.owner_phone,
      ownerEmail: dealerOnboardingApplications.owner_email,
      gstNumber: dealerOnboardingApplications.gst_number,
      panNumber: dealerOnboardingApplications.pan_number,
      city: dealerOnboardingApplications.city,
      state: dealerOnboardingApplications.state,
      waPhone: dealerOnboardingApplications.wa_phone,
      onboardingStatus: dealerOnboardingApplications.onboarding_status,
      reviewStatus: dealerOnboardingApplications.review_status,
      submittedAt: dealerOnboardingApplications.submitted_at,
      dealerCode: dealerOnboardingApplications.dealer_code,
      financeEnabled: dealerOnboardingApplications.finance_enabled,
      channel: dealerOnboardingApplications.onboarding_channel,
      firstContactAt: dealerOnboardingApplications.created_at,
      warnings: dealerOnboardingApplications.verification_warnings,
      operatorName: whatsappOperators.display_name,
      dealerSessionId: dealerSession.id,
      dealerState: dealerSession.current_state,
      dealerContactName: dealerSession.wa_contact_name,
      dealerLastInbound: dealerSession.last_inbound_at,
      dealerSessionStatus: dealerSession.session_status,
      dealerCtx: dealerSession.context,
      flow: sql<string | null>`dealer_session.context->>'flow'`,
      operatorSessionId: operatorSession.id,
      operatorState: operatorSession.current_state,
      operatorLastInbound: operatorSession.last_inbound_at,
      // wa_phone is not unique, so one number can legitimately end up with two
      // files (a self-serve start plus an operator-opened one). Surface that
      // instead of silently collapsing it — silent hiding is the bug being fixed.
      filesOnPhone: sql<number>`cast(count(*) over (partition by ${dealerOnboardingApplications.wa_phone}) as integer)`,
      lastActivityAt: lastActivity,
    })
    .from(dealerOnboardingApplications)
    .leftJoin(
      dealerSession,
      eq(dealerSession.id, dealerOnboardingApplications.wa_session_id),
    )
    .leftJoin(
      operatorSession,
      eq(operatorSession.id, dealerOnboardingApplications.wa_operator_session_id),
    )
    .leftJoin(
      whatsappOperators,
      eq(whatsappOperators.id, dealerOnboardingApplications.onboarding_operator_id),
    )
    .where(where);

  const [rows, [totals]] = await Promise.all([
    baseQuery
      .orderBy(desc(lastActivity))
      .limit(limit)
      .offset((page - 1) * limit),
    db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(dealerOnboardingApplications)
      .leftJoin(
        dealerSession,
        eq(dealerSession.id, dealerOnboardingApplications.wa_session_id),
      )
      .leftJoin(
        operatorSession,
        eq(
          operatorSession.id,
          dealerOnboardingApplications.wa_operator_session_id,
        ),
      )
      .where(where),
  ]);

  const applicationIds = rows.map((r) => r.applicationId);

  // Document types already collected, per application. Distinct types (not raw
  // rows) and excluding superseded/pending_correction history, so the count
  // matches the checklist the drawer renders.
  const typesByApp = new Map<string, Set<string>>();
  if (applicationIds.length > 0) {
    const typeRows = await db
      .select({
        applicationId: dealerOnboardingDocuments.application_id,
        documentType: dealerOnboardingDocuments.document_type,
      })
      .from(dealerOnboardingDocuments)
      .where(
        and(
          sql`${dealerOnboardingDocuments.application_id} = ANY(ARRAY[${sql.join(
            applicationIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}])`,
          notInArray(dealerOnboardingDocuments.doc_status, [
            "superseded",
            "pending_correction",
          ]),
        ),
      );
    for (const r of typeRows) {
      const set = typesByApp.get(r.applicationId) ?? new Set<string>();
      set.add(r.documentType);
      typesByApp.set(r.applicationId, set);
    }
  }

  const now = new Date();
  const conversations = rows.map((r) => {
    // An operator file's live state is on the operator's row until handoff.
    const currentState = r.dealerState ?? r.operatorState ?? null;
    const lastInboundAt = r.dealerLastInbound ?? r.operatorLastInbound ?? null;
    const resolvedStage = stageOf({
      currentState,
      onboardingStatus: r.onboardingStatus,
      reviewStatus: r.reviewStatus,
    });

    const required = requiredDocuments(r.companyType as CompanyType | null);
    const uploaded = typesByApp.get(r.applicationId) ?? new Set<string>();
    const missingDocuments = required
      .filter((d) => !uploaded.has(d.type))
      .map((d) => ({ type: d.type, label: d.label }));

    const ctx = (r.dealerCtx ?? {}) as Ctx;
    const contactType = contactTypeOf({
      currentState,
      flow: r.flow,
      companyType: r.companyType,
      onboardingStatus: r.onboardingStatus,
    });

    return {
      applicationId: r.applicationId,
      contactType,
      contactTypeLabel: CONTACT_TYPE_LABEL[contactType],
      displayName: prospectDisplayName({
        companyName: r.companyName,
        ownerName: r.ownerName,
        contactName: r.dealerContactName,
        waPhone: r.waPhone,
      }),
      // null rather than the sentinel, so no consumer can print it by accident.
      companyName: isPlaceholderCompany(r.companyName) ? null : r.companyName,
      contactName: r.dealerContactName,
      ownerName: r.ownerName,
      ownerPhone: r.ownerPhone,
      ownerEmail: r.ownerEmail,
      waPhone: r.waPhone,
      companyType: r.companyType,
      dealerType: r.dealerType,
      gstNumber: r.gstNumber,
      panNumber: r.panNumber,
      city: r.city,
      state: r.state,

      stage: resolvedStage,
      stageLabel: stageLabel(resolvedStage),
      currentState,
      activity: activityOf(lastInboundAt, now),

      docsUploaded: uploaded.size,
      docsRequired: required.length,
      missingDocuments,
      chatAnswers: Object.keys(ctx.answers ?? {}).length,

      onboardingStatus: r.onboardingStatus,
      reviewStatus: r.reviewStatus,
      submittedAt: r.submittedAt,
      dealerCode: r.dealerCode,
      financeEnabled: r.financeEnabled,
      warningCount: Array.isArray(r.warnings) ? r.warnings.length : 0,

      channel: r.channel ?? "self",
      operatorName: r.operatorName,
      firstContactAt: r.firstContactAt,
      lastInboundAt,
      lastActivityAt: r.lastActivityAt,
      sessionStatus: r.dealerSessionStatus,
      duplicateOnPhone: (r.filesOnPhone ?? 1) > 1,

      dealerSessionId: r.dealerSessionId,
      operatorSessionId: r.operatorSessionId,
    };
  });

  // Unfiltered stage tally for the tab badge, so it doesn't move as the admin
  // types in the search box.
  const summaryRows = await db
    .select({
      onboardingStatus: dealerOnboardingApplications.onboarding_status,
      companyType: dealerOnboardingApplications.company_type,
      currentState: dealerSession.current_state,
      operatorState: operatorSession.current_state,
      flow: sql<string | null>`dealer_session.context->>'flow'`,
    })
    .from(dealerOnboardingApplications)
    .leftJoin(
      dealerSession,
      eq(dealerSession.id, dealerOnboardingApplications.wa_session_id),
    )
    .leftJoin(
      operatorSession,
      eq(operatorSession.id, dealerOnboardingApplications.wa_operator_session_id),
    )
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

  return successResponse({
    conversations,
    total: totals?.count ?? 0,
    page,
    limit,
    summary: { total: summaryRows.length, inProgress, byStage, byType },
  });
});
