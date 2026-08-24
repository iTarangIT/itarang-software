/**
 * /nbfc/recovery/queue — Recovery (BRD §6.1.6)
 *
 * Where a battery goes the moment somebody presses "Flag for Recovery".
 *
 * That button already wrote three rows — the flag on `loan_sanctions`, a
 * `nbfc_recovery_pipeline` row at `needs_inspection`, and a `recovery_batteries`
 * stub — and then showed the operator nothing. The flag surfaced as a purple
 * badge back on the lead they were already looking at; the pipeline row only
 * appeared on the Kanban board, as a serial and a stage with no borrower, no
 * dealer and no money on it. So "which batteries are we recovering, and from
 * whom?" had no screen.
 *
 * This is that screen: one row per flagged loan, newest flag first, with the
 * borrower, the dealer who sold the battery, the outstanding and the DPD on the
 * row itself, and everything else — the reason typed into the dialog, the full
 * dealer record, the battery master, the pipeline position — one click down.
 *
 * Server component, same joins as Lead Intelligence so the two pages agree on
 * what a borrower and a dealer are. The Kanban at /nbfc/recovery stays the
 * place where a battery is MOVED between stages; this is the place where the
 * recovery book is READ.
 */
import "@/app/auction-theme.css";
import Link from "next/link";
import { db } from "@/lib/db";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  dealers,
  leads,
  loanSanctions,
  nbfcLoans,
  nbfcRecoveryAgents,
  nbfcRecoveryPipeline,
  nbfcUsers,
  productSelections,
  recoveryAssignments,
  recoveryBatteries,
} from "@/lib/db/schema";
import {
  getCurrentTenant,
  getSessionUser,
  requireNbfcAccess,
} from "@/lib/nbfc/tenant";
import { normalizeNbfcRole } from "@/lib/nbfc/origination-roles";
import { defaultPermissionsForRole } from "@/lib/nbfc/permissions";
import {
  computeRecoveryAutoFlags,
  listAssignmentPhotos,
  listVisitAttempts,
} from "@/lib/nbfc/recovery/assignment";
import RecoveryQueueTable, {
  type AgentOption,
  type RecoveryRow,
} from "./_components/RecoveryQueueTable";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Recovery",
};

/**
 * `dealers.registered_address` is jsonb in some rows and a plain string in
 * others (the onboarding flow changed shape mid-life). Both render.
 */
function formatAddress(value: unknown): string | null {
  if (value == null) return null;
  let obj: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return trimmed;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    if (typeof o.address === "string" && o.address.trim()) {
      return o.address.trim();
    }
    const parts = [
      o.line1,
      o.line2,
      o.street,
      o.area,
      o.city,
      o.district,
      o.state,
      o.pincode ?? o.pin ?? o.zip,
    ]
      .map((p) => (p == null ? "" : String(p).trim()))
      .filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : null;
  }
  return null;
}

const num = (v: string | number | null | undefined): number | null => {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

export default async function NbfcRecoveryQueuePage() {
  const tenant = await getCurrentTenant();
  await requireNbfcAccess(tenant.id);

  // The flag lives on loan_sanctions, so that is the driving table here —
  // Lead Intelligence drives off nbfc_loans instead, and a flagged loan whose
  // servicing row is missing would silently drop out of a recovery list.
  const joined = (await db
    .select({
      sanction_id: loanSanctions.id,
      loan_file_number: loanSanctions.loan_file_number,
      loan_amount: loanSanctions.loan_amount,
      sanction_status: loanSanctions.status,
      sanctioned_at: loanSanctions.sanctioned_at,
      recovery_flagged_at: loanSanctions.recovery_flagged_at,
      recovery_reason: loanSanctions.recovery_reason,
      lead_id: loanSanctions.lead_id,
      reference_id: leads.reference_id,
      borrower_name: sql<
        string | null
      >`coalesce(${leads.full_name}, ${leads.owner_name})`,
      borrower_phone: sql<
        string | null
      >`coalesce(${leads.mobile}, ${leads.phone}, ${leads.owner_contact})`,
      city: leads.city,
      state: leads.state,
      dealer_code: dealers.dealer_id,
      dealer_name: dealers.company_name,
      dealer_owner: dealers.owner_name,
      dealer_phone: dealers.owner_phone,
      dealer_email: dealers.owner_email,
      dealer_gst: dealers.gst_number,
      dealer_address: dealers.registered_address,
      product_model: sql<
        string | null
      >`coalesce(${productSelections.model_number}, ${leads.asset_model})`,
      vehicleno: nbfcLoans.vehicleno,
      current_dpd: nbfcLoans.current_dpd,
      outstanding_amount: nbfcLoans.outstanding_amount,
    })
    .from(loanSanctions)
    .leftJoin(leads, eq(leads.id, loanSanctions.lead_id))
    .leftJoin(dealers, eq(dealers.dealer_id, leads.dealer_id))
    .leftJoin(
      productSelections,
      eq(productSelections.id, loanSanctions.product_selection_id),
    )
    .leftJoin(nbfcLoans, eq(nbfcLoans.loan_application_id, loanSanctions.id))
    .where(
      and(
        eq(loanSanctions.nbfc_id, tenant.id),
        isNotNull(loanSanctions.recovery_flagged_at),
      ),
    )
    .orderBy(desc(loanSanctions.recovery_flagged_at))) as Array<{
    sanction_id: string;
    loan_file_number: string | null;
    loan_amount: string | null;
    sanction_status: string | null;
    sanctioned_at: Date | null;
    recovery_flagged_at: Date | null;
    recovery_reason: string | null;
    lead_id: string | null;
    reference_id: string | null;
    borrower_name: string | null;
    borrower_phone: string | null;
    city: string | null;
    state: string | null;
    dealer_code: string | null;
    dealer_name: string | null;
    dealer_owner: string | null;
    dealer_phone: string | null;
    dealer_email: string | null;
    dealer_gst: string | null;
    dealer_address: unknown;
    product_model: string | null;
    vehicleno: string | null;
    current_dpd: number | null;
    outstanding_amount: string | null;
  }>;

  // A loan with two servicing rows must not become two recovery rows. First
  // wins — the join is ordered by the flag, and the duplicate carries the same
  // sanction either way.
  const bySanction = new Map<string, (typeof joined)[number]>();
  for (const r of joined) {
    if (!bySanction.has(r.sanction_id)) bySanction.set(r.sanction_id, r);
  }
  const base = [...bySanction.values()];

  const sanctionIds = base.map((r) => r.sanction_id);

  // The battery master stub that flagLoanForRecovery seeds, keyed on the loan.
  const batteryRows =
    sanctionIds.length > 0
      ? await db
          .select({
            id: recoveryBatteries.id,
            serial: recoveryBatteries.serial,
            model: recoveryBatteries.model,
            capacity: recoveryBatteries.capacity,
            condition_grade: recoveryBatteries.condition_grade,
            state_code: recoveryBatteries.state_code,
            warehouse: recoveryBatteries.warehouse,
            city: recoveryBatteries.city,
            state: recoveryBatteries.state,
            recovery_date: recoveryBatteries.recovery_date,
            image_urls: recoveryBatteries.image_urls,
            loan_sanction_id: recoveryBatteries.loan_sanction_id,
          })
          .from(recoveryBatteries)
          .where(
            and(
              eq(recoveryBatteries.tenant_id, tenant.id),
              inArray(recoveryBatteries.loan_sanction_id, sanctionIds),
            ),
          )
      : [];
  const batteryByLoan = new Map(
    batteryRows
      .filter((b) => b.loan_sanction_id)
      .map((b) => [b.loan_sanction_id as string, b]),
  );

  // The workflow position. Keyed on the serial, which is how the flag wrote it
  // — including the `LOAN-<id>` placeholder used when no serial was known.
  const pipelineRows = await db
    .select({
      id: nbfcRecoveryPipeline.id,
      battery_serial: nbfcRecoveryPipeline.battery_serial,
      stage: nbfcRecoveryPipeline.stage,
      estimated_recovery_value: nbfcRecoveryPipeline.estimated_recovery_value,
      updated_at: nbfcRecoveryPipeline.updated_at,
    })
    .from(nbfcRecoveryPipeline)
    .where(eq(nbfcRecoveryPipeline.tenant_id, tenant.id));
  const pipelineBySerial = new Map(
    pipelineRows.map((p) => [p.battery_serial, p]),
  );

  // Same EMI rollup the Lead Intelligence page uses, so DPD and the next due
  // date read identically on both screens.
  const emiRows =
    sanctionIds.length > 0
      ? ((await db.execute(sql`
          SELECT es.loan_sanction_id AS loan_sanction_id,
                 MIN(LEAST(720, GREATEST(0, CURRENT_DATE - es.due_date))) FILTER (WHERE es.status IN ('overdue', 'missed'))::int AS overdue_days,
                 MIN(es.due_date) FILTER (WHERE es.status = 'scheduled' AND es.due_date >= CURRENT_DATE)::text AS next_emi_date
            FROM emi_schedules es
            JOIN loan_sanctions ls ON ls.id = es.loan_sanction_id
           WHERE ls.nbfc_id = ${tenant.id}
             AND es.loan_sanction_id IN (${sql.join(
               sanctionIds.map((id) => sql`${id}`),
               sql`, `,
             )})
           GROUP BY es.loan_sanction_id
        `)) as unknown as Array<{
          loan_sanction_id: string;
          overdue_days: number | null;
          next_emi_date: string | null;
        }>)
      : [];
  const emiBySanction = new Map(emiRows.map((r) => [r.loan_sanction_id, r]));

  // [E-262] The live dispatch per loan. `is_current` is false on every
  // superseded attempt, and the partial unique index guarantees at most one
  // open row per loan, so this map is unambiguous by construction.
  const assignmentRows =
    sanctionIds.length > 0
      ? await db
          .select()
          .from(recoveryAssignments)
          .where(
            and(
              eq(recoveryAssignments.tenant_id, tenant.id),
              eq(recoveryAssignments.is_current, true),
              inArray(recoveryAssignments.loan_sanction_id, sanctionIds),
            ),
          )
      : [];
  const assignmentByLoan = new Map(
    assignmentRows.map((a) => [a.loan_sanction_id, a]),
  );

  // The agent's evidence, for the handful of jobs that are actually waiting on
  // a decision. Fetched HERE rather than by the panel on open, for two reasons:
  // the reviewer should see the photographs the instant they expand a row, and
  // a client-side fetch-on-mount is a setState-in-effect the React compiler is
  // right to complain about.
  const evidenceFor = assignmentRows.filter(
    (a) => a.status === "collected" || a.status === "completed",
  );
  const evidenceByAssignment = new Map(
    await Promise.all(
      evidenceFor.map(async (a) => {
        const photos = await listAssignmentPhotos(a.id);
        return [
          a.id,
          {
            photos: photos.map((ph) => ({
              id: ph.id,
              photo_type: ph.photo_type,
              image_url: ph.image_url,
              watermark_applied: ph.watermark_applied,
            })),
            auto_flags: computeRecoveryAutoFlags(a, photos),
          },
        ] as const;
      }),
    ),
  );

  // [E-263] The failed journeys. Fetched for every assignment that HAS any —
  // `visit_attempt_count` is the parent's cache of exactly that, so this costs
  // a query only for the jobs where somebody actually went and came back empty.
  const visitsFor = assignmentRows.filter((a) => (a.visit_attempt_count ?? 0) > 0);
  const visitsByAssignment = new Map(
    await Promise.all(
      visitsFor.map(async (a) => {
        const rows = await listVisitAttempts(a.id);
        return [
          a.id,
          rows.map((v) => ({
            attempt_no: v.attempt_no,
            outcome: v.outcome,
            notes: v.notes,
            next_visit_at: v.next_visit_at ? v.next_visit_at.toISOString() : null,
            created_at: v.created_at.toISOString(),
            distance_from_address_m: num(v.distance_from_address_m),
            gps_lat: num(v.gps_lat),
            gps_lng: num(v.gps_lng),
          })),
        ] as const;
      }),
    ),
  );

  // Only ACTIVE agents reach the picker — a deactivated one is still named on
  // the jobs they already did, but must not be dispatchable.
  const agentRows = await db
    .select({
      id: nbfcRecoveryAgents.id,
      name: nbfcRecoveryAgents.name,
      city: nbfcRecoveryAgents.city,
      coverage_area: nbfcRecoveryAgents.coverage_area,
      phone: nbfcRecoveryAgents.phone,
      email: nbfcRecoveryAgents.email,
      preferred_channel: nbfcRecoveryAgents.preferred_channel,
    })
    .from(nbfcRecoveryAgents)
    .where(
      and(
        eq(nbfcRecoveryAgents.tenant_id, tenant.id),
        eq(nbfcRecoveryAgents.active, true),
      ),
    )
    .orderBy(nbfcRecoveryAgents.name);
  const agents: AgentOption[] = agentRows.map((a) => ({
    id: a.id,
    name: a.name,
    city: a.city,
    coverage_area: a.coverage_area,
    contact: a.email ?? a.phone,
    preferred_channel: a.preferred_channel,
  }));

  // What this user may do, resolved from their system-role defaults. This is a
  // HINT for the UI, not the gate: a custom DB-backed role is resolved properly
  // by `resolveActor` inside the API routes, which are what actually refuse.
  // Showing a button that 403s is worse than hiding it, and hiding one that
  // would have worked is recoverable — the route is still there.
  const session = await getSessionUser();
  const [membership] = session?.id
    ? await db
        .select({ role: nbfcUsers.role })
        .from(nbfcUsers)
        .where(
          and(
            eq(nbfcUsers.tenant_id, tenant.id),
            eq(nbfcUsers.user_id, session.id),
          ),
        )
        .limit(1)
    : [];
  const myPermissions = new Set(
    defaultPermissionsForRole(normalizeNbfcRole(membership?.role ?? "viewer")),
  );
  const can = {
    assign: myPermissions.has("recovery.assign_agent"),
    review: myPermissions.has("recovery.review"),
    cancel: myPermissions.has("recovery.cancel"),
  };

  const rows: RecoveryRow[] = base.map((r) => {
    const battery = batteryByLoan.get(r.sanction_id) ?? null;
    const serial = battery?.serial ?? r.vehicleno ?? null;
    const pipeline = serial
      ? pipelineBySerial.get(serial) ??
        pipelineBySerial.get(`LOAN-${r.sanction_id}`) ??
        null
      : pipelineBySerial.get(`LOAN-${r.sanction_id}`) ?? null;
    const emi = emiBySanction.get(r.sanction_id);

    return {
      sanction_id: r.sanction_id,
      lead_id: r.lead_id,
      reference_id: r.reference_id,
      loan_file_number: r.loan_file_number,
      loan_amount: num(r.loan_amount),
      sanction_status: r.sanction_status,
      sanctioned_at: r.sanctioned_at ? r.sanctioned_at.toISOString() : null,
      flagged_at: r.recovery_flagged_at
        ? r.recovery_flagged_at.toISOString()
        : null,
      reason: r.recovery_reason,

      borrower_name: r.borrower_name,
      borrower_phone: r.borrower_phone,
      city: r.city,
      state: r.state,

      dealer_code: r.dealer_code,
      dealer_name: r.dealer_name,
      dealer_owner: r.dealer_owner,
      dealer_phone: r.dealer_phone,
      dealer_email: r.dealer_email,
      dealer_gst: r.dealer_gst,
      dealer_address: formatAddress(r.dealer_address),

      product_model: r.product_model,
      outstanding: num(r.outstanding_amount),
      // nbfc_loans.current_dpd is stamped by the aging job; the live figure
      // from emi_schedules wins when it exists, exactly as on Lead Intelligence.
      dpd: emi?.overdue_days ?? r.current_dpd ?? null,
      next_emi_date: emi?.next_emi_date ?? null,

      battery_serial: serial,
      battery_id: battery?.id ?? null,
      battery_model: battery?.model ?? null,
      battery_capacity: battery?.capacity ?? null,
      battery_condition: battery?.condition_grade ?? null,
      battery_state: battery?.state_code ?? null,
      battery_warehouse: battery?.warehouse ?? null,
      battery_city: battery?.city ?? null,
      battery_state_name: battery?.state ?? null,
      battery_photos: battery?.image_urls?.length ?? 0,
      recovery_date: battery?.recovery_date
        ? battery.recovery_date.toISOString()
        : null,

      pipeline_id: pipeline?.id ?? null,
      stage: pipeline?.stage ?? null,
      estimated_recovery_value: num(pipeline?.estimated_recovery_value ?? null),
      stage_updated_at: pipeline?.updated_at
        ? pipeline.updated_at.toISOString()
        : null,

      assignment: (() => {
        const a = assignmentByLoan.get(r.sanction_id);
        if (!a) return null;
        return {
          id: a.id,
          status: a.status,
          attempt_no: a.attempt_no,
          agent_id: a.agent_id,
          agent_name: a.agent_name,
          agent_phone: a.agent_phone,
          assigned_at: a.assigned_at ? a.assigned_at.toISOString() : null,
          due_at: a.due_at ? a.due_at.toISOString() : null,
          link_sent_at: a.link_sent_at ? a.link_sent_at.toISOString() : null,
          link_channel: a.link_channel,
          link_expires_at: a.link_expires_at
            ? a.link_expires_at.toISOString()
            : null,
          dispatch_error: a.dispatch_error,
          collected_at: a.collected_at ? a.collected_at.toISOString() : null,
          condition_notes: a.condition_notes,
          distance_from_address_m: num(a.distance_from_address_m),
          gps_accuracy_m: num(a.gps_accuracy_m),
          gps_lat: num(a.gps_lat),
          gps_lng: num(a.gps_lng),
          has_address_anchor: a.stated_lat != null && a.stated_lng != null,
          cancel_reason: a.cancel_reason,
          cancel_source: a.cancel_source,
          cancelled_at: a.cancelled_at ? a.cancelled_at.toISOString() : null,
          review_decision: a.review_decision,
          review_notes: a.review_notes,
          reviewed_at: a.reviewed_at ? a.reviewed_at.toISOString() : null,
          // Decided here, against the server clock. Nothing flips a row when its
          // link lapses — expiry is a comparison, not a state — and reading the
          // browser's clock during render is both impure and a hydration
          // mismatch waiting to happen.
          link_expired:
            a.link_expires_at != null &&
            a.link_expires_at.getTime() < Date.now(),
          photos: evidenceByAssignment.get(a.id)?.photos ?? [],
          auto_flags: evidenceByAssignment.get(a.id)?.auto_flags ?? [],
          next_visit_at: a.next_visit_at ? a.next_visit_at.toISOString() : null,
          visit_attempt_count: a.visit_attempt_count ?? 0,
          visits: visitsByAssignment.get(a.id) ?? [],
        };
      })(),
    };
  });

  return (
    <div className="p-4 md:p-6">
      <div className="auction-sheet">
        <div className="auc-sheet-head">
          <div>
            <p className="auc-eyebrow">Recovery · Flagged book</p>
            <h1 className="auc-h1">Recovery</h1>
            <p className="auc-lede">
              Every loan flagged for recovery, newest first. The battery, the
              borrower and the dealer who sold it are on one row; open a row for
              the reason it was flagged and the full record behind it.
            </p>
          </div>
          <div className="auc-head-actions">
            <Link href="/nbfc/recovery" className="auc-btn" data-variant="ghost">
              Recovery board
            </Link>
            <Link
              href="/nbfc/recovery/batteries"
              className="auc-btn"
              data-variant="ghost"
            >
              Battery register
            </Link>
          </div>
        </div>
        <RecoveryQueueTable rows={rows} agents={agents} can={can} />
      </div>
    </div>
  );
}
