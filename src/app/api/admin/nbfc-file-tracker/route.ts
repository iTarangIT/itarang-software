/**
 * E-280 — the admin's cross-lead view of every file sitting with an NBFC.
 *
 * Read-only, no migration. Every timestamp it reports already exists; what was
 * missing was anything that read them TOGETHER. `/api/admin/kyc-reviews` never
 * touches `nbfc_lead_assignments`, and the per-lead admin NBFC routes are all
 * keyed by one leadId, so "which files are stuck, and on whom" could not be
 * asked at all.
 *
 * One query with correlated sub-selects for the four things that can block a
 * file, then `deriveFileStage` turns those columns into a stage. The clock is
 * Postgres `now()`, not the Node clock — the SLA sweeps this compares against
 * use the database clock, and skew between the two has bitten this repo before.
 *
 * `?format=csv` is the bulk export; the per-file history lives at
 * `./[leadId]`.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import {
  csvDateTime,
  csvResponse,
  QUEUE_EXPORT_ROW_CAP,
  type CsvColumn,
} from "@/lib/leads/queueCsv";
import {
  deriveFileStage,
  formatDuration,
  WAITING_ON_LABEL,
  type WaitingOn,
} from "@/lib/nbfc/file-tracker";

export const dynamic = "force-dynamic";

// Same roles that may read the KYC review queue this tab lives on.
const ADMIN_ROLES = [
  "admin",
  "ceo",
  "business_head",
  "sales_head",
  "sales_manager",
  "sales_executive",
];

const JSON_ROW_CAP = 500;

type DbRow = {
  assignment_id: string;
  lead_id: string;
  reference_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  city: string | null;
  state: string | null;
  kyc_status: string | null;
  dealer_code: string | null;
  dealer_name: string | null;
  nbfc_id: number;
  nbfc_short_name: string | null;
  nbfc_code: string | null;
  product_name: string | null;
  assignment_status: string;
  assigned_at: string | null;
  decided_at: string | null;
  decision_reason: string | null;
  rejection_forwarded_at: string | null;
  rejection_admin_due_at: string | null;
  open_request_status: string | null;
  open_request_updated_at: string | null;
  open_request_sla_due_at: string | null;
  open_request_count: number;
  verdict_kind: string | null;
  verdict_verified_at: string | null;
  verdict_sla_due_at: string | null;
  offer_submitted_at: string | null;
  sanctioned_at: string | null;
  disbursed_at: string | null;
  last_activity_at: string | null;
  db_now: string;
};

export interface TrackerRow {
  assignmentId: string;
  leadId: string;
  referenceId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  city: string | null;
  state: string | null;
  dealerCode: string | null;
  dealerName: string | null;
  nbfcId: number;
  nbfcShortName: string | null;
  nbfcCode: string | null;
  productName: string | null;
  assignmentStatus: string;
  assignedAt: string | null;
  stageKey: string;
  stageLabel: string;
  waitingOn: WaitingOn;
  stageSince: string | null;
  timeInStageMs: number | null;
  totalAgeMs: number | null;
  openRequests: number;
  slaDueAt: string | null;
  slaOverdue: boolean;
  lastActivityAt: string | null;
}

const d = (v: string | null | undefined): Date | null =>
  v ? new Date(v) : null;

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole(ADMIN_ROLES);

  const url = new URL(req.url);
  const search = (url.searchParams.get("search") ?? "").trim();
  const nbfcId = url.searchParams.get("nbfcId");
  const waitingOnFilter = url.searchParams.get("waitingOn");
  const stageFilter = url.searchParams.get("stage");
  const overdueOnly = url.searchParams.get("overdue") === "1";
  const wantsCsv = url.searchParams.get("format") === "csv";
  // A per-row download asks for one lead's row; the [leadId] route handles the
  // richer action history, this just keeps the summary consistent.
  const leadIds = (url.searchParams.get("leadIds") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const like = `%${search.toLowerCase()}%`;

  const rows = await db.execute<DbRow>(sql`
    SELECT
      a.id::text                        AS assignment_id,
      a.lead_id                         AS lead_id,
      l.reference_id                    AS reference_id,
      COALESCE(l.full_name, l.owner_name) AS customer_name,
      COALESCE(l.mobile, l.phone)       AS customer_phone,
      l.city                            AS city,
      l.state                           AS state,
      l.kyc_status                      AS kyc_status,
      l.dealer_id                       AS dealer_code,
      acc.business_entity_name          AS dealer_name,
      a.nbfc_id                         AS nbfc_id,
      n.short_name                      AS nbfc_short_name,
      n.nbfc_id                         AS nbfc_code,
      p.product_name                    AS product_name,
      a.status                          AS assignment_status,
      a.assigned_at                     AS assigned_at,
      a.decided_at                      AS decided_at,
      a.decision_reason                 AS decision_reason,
      a.rejection_forwarded_at          AS rejection_forwarded_at,
      a.rejection_admin_due_at          AS rejection_admin_due_at,

      req.status                        AS open_request_status,
      req.updated_at                    AS open_request_updated_at,
      req.sla_due_at                    AS open_request_sla_due_at,
      COALESCE(reqc.n, 0)::int          AS open_request_count,

      ver.verdict                       AS verdict_kind,
      ver.verified_at                   AS verdict_verified_at,
      ver.sla_due_at                    AS verdict_sla_due_at,

      off.submitted_at                  AS offer_submitted_at,
      ls.sanctioned_at                  AS sanctioned_at,
      ls.disbursed_at                   AS disbursed_at,

      GREATEST(
        a.updated_at,
        COALESCE(req.updated_at, a.updated_at),
        COALESCE(ver.updated_at, a.updated_at),
        COALESCE(off.updated_at, a.updated_at)
      )                                 AS last_activity_at,
      now()                             AS db_now

    FROM nbfc_lead_assignments a
    LEFT JOIN leads    l   ON l.id = a.lead_id
    LEFT JOIN accounts acc ON acc.id = l.dealer_id
    LEFT JOIN nbfc     n   ON n.id = a.nbfc_id
    LEFT JOIN nbfc_loan_products p ON p.id = a.loan_product_id

    -- The oldest still-open document request. Terminal statuses are excluded
    -- so a closed thread never reads as a block.
    LEFT JOIN LATERAL (
      SELECT r.status, r.updated_at, r.sla_due_at
        FROM nbfc_doc_requests r
       WHERE r.assignment_id = a.id
         AND r.status NOT IN ('pushed_to_nbfc', 'closed', 'rejected')
       ORDER BY r.created_at ASC
       LIMIT 1
    ) req ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) AS n
        FROM nbfc_doc_requests r
       WHERE r.assignment_id = a.id
         AND r.status NOT IN ('pushed_to_nbfc', 'closed', 'rejected')
    ) reqc ON TRUE

    -- The oldest queried/rejected verdict nobody has forwarded yet.
    LEFT JOIN LATERAL (
      SELECT v.verdict, v.verified_at, v.sla_due_at, v.updated_at
        FROM nbfc_document_verifications v
       WHERE v.assignment_id = a.id
         AND v.verdict IN ('queried', 'rejected')
         AND v.forwarded_at IS NULL
       ORDER BY v.created_at ASC
       LIMIT 1
    ) ver ON TRUE

    LEFT JOIN LATERAL (
      SELECT o.submitted_at, o.updated_at
        FROM nbfc_financing_offers o
       WHERE o.assignment_id = a.id
       ORDER BY o.updated_at DESC
       LIMIT 1
    ) off ON TRUE

    LEFT JOIN LATERAL (
      SELECT s.sanctioned_at, s.disbursed_at
        FROM loan_sanctions s
       WHERE s.lead_id = a.lead_id
       ORDER BY s.created_at DESC
       LIMIT 1
    ) ls ON TRUE

    WHERE TRUE
      ${nbfcId ? sql`AND a.nbfc_id = ${Number(nbfcId)}` : sql``}
      ${
        leadIds.length > 0
          ? sql`AND a.lead_id IN (${sql.join(
              leadIds.map((v) => sql`${v}`),
              sql`, `,
            )})`
          : sql``
      }
      ${
        search
          ? sql`AND (
              lower(COALESCE(l.full_name, l.owner_name, '')) LIKE ${like}
              OR lower(COALESCE(l.reference_id, '')) LIKE ${like}
              OR lower(a.lead_id) LIKE ${like}
              OR lower(COALESCE(acc.business_entity_name, '')) LIKE ${like}
              OR lower(COALESCE(l.mobile, l.phone, '')) LIKE ${like}
            )`
          : sql``
      }
    ORDER BY a.assigned_at ASC
    LIMIT ${QUEUE_EXPORT_ROW_CAP}
  `);

  // Stage, and everything derived from it, is computed here rather than in SQL:
  // the precedence between a rejection, an open request and an unforwarded
  // verdict is business logic, and it lives in exactly one place.
  const nowMs = rows[0]?.db_now
    ? new Date(rows[0].db_now).getTime()
    : Date.now();

  let mapped: TrackerRow[] = rows.map((r) => {
    const stage = deriveFileStage({
      assignmentStatus: r.assignment_status,
      assignedAt: d(r.assigned_at),
      decidedAt: d(r.decided_at),
      rejectionForwardedAt: d(r.rejection_forwarded_at),
      rejectionAdminDueAt: d(r.rejection_admin_due_at),
      openRequest: r.open_request_status
        ? {
            status: r.open_request_status,
            updatedAt: d(r.open_request_updated_at),
            slaDueAt: d(r.open_request_sla_due_at),
          }
        : null,
      pendingVerdict: r.verdict_kind
        ? {
            verdict: r.verdict_kind,
            verifiedAt: d(r.verdict_verified_at),
            slaDueAt: d(r.verdict_sla_due_at),
          }
        : null,
      offerSubmittedAt: d(r.offer_submitted_at),
      sanctionedAt: d(r.sanctioned_at),
      disbursedAt: d(r.disbursed_at),
    });

    const assignedAt = d(r.assigned_at);
    return {
      assignmentId: r.assignment_id,
      leadId: r.lead_id,
      referenceId: r.reference_id,
      customerName: r.customer_name,
      customerPhone: r.customer_phone,
      city: r.city,
      state: r.state,
      dealerCode: r.dealer_code,
      dealerName: r.dealer_name,
      nbfcId: Number(r.nbfc_id),
      nbfcShortName: r.nbfc_short_name,
      nbfcCode: r.nbfc_code,
      productName: r.product_name,
      assignmentStatus: r.assignment_status,
      assignedAt: r.assigned_at,
      stageKey: stage.key,
      stageLabel: stage.label,
      waitingOn: stage.waitingOn,
      stageSince: stage.since ? stage.since.toISOString() : null,
      timeInStageMs: stage.since ? nowMs - stage.since.getTime() : null,
      totalAgeMs: assignedAt ? nowMs - assignedAt.getTime() : null,
      openRequests: Number(r.open_request_count ?? 0),
      slaDueAt: stage.slaDueAt ? stage.slaDueAt.toISOString() : null,
      slaOverdue: stage.slaDueAt ? stage.slaDueAt.getTime() < nowMs : false,
      lastActivityAt: r.last_activity_at,
    };
  });

  // Stage-derived filters run after derivation, for the same reason the
  // derivation is not in SQL.
  if (waitingOnFilter) {
    mapped = mapped.filter((r) => r.waitingOn === waitingOnFilter);
  }
  if (stageFilter) {
    mapped = mapped.filter((r) => r.stageKey === stageFilter);
  }
  if (overdueOnly) {
    mapped = mapped.filter((r) => r.slaOverdue);
  }

  // Longest-waiting first: the point of the screen is the stuck ones.
  mapped.sort((a, b) => (b.totalAgeMs ?? 0) - (a.totalAgeMs ?? 0));

  if (wantsCsv) {
    return csvResponse<TrackerRow>({
      rows: mapped,
      columns: CSV_COLUMNS,
      filename: "nbfc-file-tracker",
      total: mapped.length,
    });
  }

  return successResponse({
    rows: mapped.slice(0, JSON_ROW_CAP),
    total: mapped.length,
    truncated: mapped.length > JSON_ROW_CAP,
  });
});

const CSV_COLUMNS: CsvColumn<TrackerRow>[] = [
  { header: "Lead Ref", value: (r) => r.referenceId ?? r.leadId },
  { header: "Lead ID", value: (r) => r.leadId },
  { header: "Customer", value: (r) => r.customerName ?? "" },
  { header: "Phone", value: (r) => r.customerPhone ?? "" },
  { header: "City", value: (r) => r.city ?? "" },
  { header: "State", value: (r) => r.state ?? "" },
  { header: "Dealer", value: (r) => r.dealerName ?? "" },
  { header: "Dealer Code", value: (r) => r.dealerCode ?? "" },
  { header: "NBFC", value: (r) => r.nbfcShortName ?? "" },
  { header: "NBFC Code", value: (r) => r.nbfcCode ?? "" },
  { header: "Loan Product", value: (r) => r.productName ?? "" },
  { header: "Assignment Status", value: (r) => r.assignmentStatus },
  { header: "Stage", value: (r) => r.stageLabel },
  { header: "Waiting On", value: (r) => WAITING_ON_LABEL[r.waitingOn] },
  { header: "Sent To NBFC", value: (r) => csvDateTime(r.assignedAt) },
  { header: "In Stage Since", value: (r) => csvDateTime(r.stageSince) },
  { header: "Time In Stage", value: (r) => formatDuration(r.timeInStageMs) },
  { header: "Total Age", value: (r) => formatDuration(r.totalAgeMs) },
  { header: "Open Requests", value: (r) => String(r.openRequests) },
  { header: "SLA Due", value: (r) => csvDateTime(r.slaDueAt) },
  { header: "SLA Overdue", value: (r) => (r.slaOverdue ? "YES" : "") },
  { header: "Last Activity", value: (r) => csvDateTime(r.lastActivityAt) },
];
