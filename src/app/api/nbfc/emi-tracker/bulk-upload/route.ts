/**
 * POST /api/nbfc/emi-tracker/bulk-upload
 *
 * Bulk version of the per-loan EMI Tracker Edit. Takes a parsed spreadsheet
 * (header row + 2-D data rows), re-validates it SERVER-SIDE (never trusts the
 * client preview), matches each row to a loan already on the tracker by battery
 * serial, and — on commit — (1) writes DISPLAY overrides to
 * nbfc_emi_tracker_overrides for the summary row, and (2) corrects the canonical
 * emi_schedules installments each collection covers (Paid/Paid-Late + cleared
 * date, mirroring the per-EMI Edit; blank slots untouched). Because CDS + PCI
 * read emi_schedules, it then runs a best-effort DPD/CDS/PCI recompute so the
 * portfolio, battery and lead pages don't go stale. Canonical lead data and the
 * installment DUE amount are never mutated.
 *
 * Body: {
 *   mode: "validate" | "commit",
 *   header: unknown[],
 *   rows: unknown[][],
 *   includeRowNumbers?: number[]   // commit only — the operator's final selection
 * }
 *
 * "validate" returns the per-row report with no writes. "commit" applies the
 * selected rows (each wrapped in a SAVEPOINT so one bad row can't abort the
 * batch) and writes a single summary audit-log entry.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { clientError } from "@/lib/nbfc/http-error";
import {
  emiSchedules,
  nbfcAuditLog,
  nbfcEmiTrackerOverrides,
  nbfcLoans,
} from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { SYSTEM_USER_ID } from "@/lib/nbfc/servicing/applyEmiPayment";
import { runEmiAging } from "@/lib/nbfc/servicing/runEmiAging";
import { runCdsNightlyJob } from "@/lib/nbfc/cds/computeCds";
import { computePciForAllLoans } from "@/lib/nbfc/pci/computePci";
import {
  parseEmiUploadRows,
  planScheduleUpdates,
  normalizeSerial,
  type ParsedRow,
  type ReportRow,
  type ScheduleRow,
  type UploadSummary,
} from "@/lib/nbfc/emi-tracker/bulkUpload";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_ROWS = 2000;

/** Postgres-safe savepoint name from a row number. */
function makeSavepoint(rowNumber: number): string {
  return `sp_bulk_${rowNumber}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 63);
}

/** Build the report row for one parsed row given the loan match + duplicate maps. */
function toReportRow(
  p: ParsedRow,
  loansBySerial: Map<string, string[]>,
  overriddenLoanIds: Set<string>,
): ReportRow {
  const base: ReportRow = {
    rowNumber: p.rowNumber,
    batteryNo: p.batteryNo,
    borrower: p.borrower,
    state: "error",
    loanId: null,
    issues: [...p.issues],
    derived: p.derived,
    paidCount: p.paidCount,
    note: null,
    noLoanMatch: false,
    scheduleUpdateCount: 0,
    scheduleNote: null,
  };

  // Cell/row validation problems block the row outright.
  if (p.issues.length > 0) return base;

  const key = normalizeSerial(p.batteryNo);
  const matches = (key && loansBySerial.get(key)) || [];

  if (matches.length === 0) {
    // No loan matches — flag it so the operator can force-import the row as a
    // standalone, display-only tracker entry (E-183). Still an error state so
    // it isn't applied by the normal "Apply selected" path.
    base.noLoanMatch = true;
    base.issues.push({
      column: "Battery No",
      value: p.batteryNo ?? "",
      message: `No active loan with battery '${p.batteryNo}' on this tracker.`,
    });
    return base;
  }
  if (matches.length > 1) {
    base.issues.push({
      column: "Battery No",
      value: p.batteryNo ?? "",
      message: `Battery '${p.batteryNo}' matches ${matches.length} loans — resolve the duplicate before uploading.`,
    });
    return base;
  }

  base.loanId = matches[0];
  if (overriddenLoanIds.has(matches[0])) {
    base.state = "duplicate";
    base.note = "Already on tracker — tick to overwrite.";
  } else {
    base.state = "ready";
  }
  return base;
}

function summarize(report: ReportRow[]): UploadSummary {
  return {
    total: report.length,
    ready: report.filter((r) => r.state === "ready").length,
    duplicate: report.filter((r) => r.state === "duplicate").length,
    error: report.filter((r) => r.state === "error").length,
  };
}

export async function POST(req: NextRequest) {
  try {
    const tenant = await getCurrentTenant();
    const session = await requireNbfcAccess(tenant.id);
    const actorUserId = "id" in session ? session.id : SYSTEM_USER_ID;

    const body = (await req.json().catch(() => null)) as {
      mode?: unknown;
      header?: unknown;
      rows?: unknown;
      includeRowNumbers?: unknown;
      standaloneRowNumbers?: unknown;
    } | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON body" }, { status: 400 });
    }

    const mode = body.mode === "commit" ? "commit" : "validate";
    const header = Array.isArray(body.header) ? body.header : null;
    const rawRows = Array.isArray(body.rows) ? (body.rows as unknown[][]) : null;
    if (!header || !rawRows) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: header[] and rows[][] are required" },
        { status: 400 },
      );
    }
    if (rawRows.length > MAX_ROWS) {
      return NextResponse.json(
        { ok: false, error: `BAD_REQUEST: too many rows (max ${MAX_ROWS})` },
        { status: 400 },
      );
    }

    // Parse + validate server-side (authoritative).
    const parsed = parseEmiUploadRows(header, rawRows);

    // Match by battery serial against ACTIVE tracker loans for this tenant.
    const loanRows = await db
      .select({ id: nbfcLoans.loan_application_id, vehicleno: nbfcLoans.vehicleno })
      .from(nbfcLoans)
      .where(and(eq(nbfcLoans.tenant_id, tenant.id), eq(nbfcLoans.is_active, true)));

    const loansBySerial = new Map<string, string[]>();
    for (const l of loanRows) {
      const key = normalizeSerial(l.vehicleno);
      if (!key) continue;
      const arr = loansBySerial.get(key);
      if (arr) arr.push(l.id);
      else loansBySerial.set(key, [l.id]);
    }

    // Which loans already have an override row (→ "duplicate").
    const overrideRows = await db
      .select({ id: nbfcEmiTrackerOverrides.loan_application_id })
      .from(nbfcEmiTrackerOverrides)
      .where(eq(nbfcEmiTrackerOverrides.tenant_id, tenant.id));
    const overriddenLoanIds = new Set(overrideRows.map((r) => r.id));

    const report = parsed.map((p) => toReportRow(p, loansBySerial, overriddenLoanIds));

    // ── Schedule-correction plan ────────────────────────────────────────────
    // For every matched loan, load its installments and work out which ones the
    // sheet's collections would flip to Paid/Paid-Late in the drawer. Pure
    // preview here; the same plan is re-derived (server-side) on commit.
    const parsedByRow = new Map(parsed.map((p) => [p.rowNumber, p]));
    const matchedLoanIds = [...new Set(report.filter((r) => r.loanId).map((r) => r.loanId as string))];

    const schedulesByLoan = new Map<string, ScheduleRow[]>();
    if (matchedLoanIds.length > 0) {
      const sched = await db
        .select({
          id: emiSchedules.id,
          loan_sanction_id: emiSchedules.loan_sanction_id,
          emi_seq: emiSchedules.emi_seq,
          due_date: emiSchedules.due_date,
          status: emiSchedules.status,
          paid_at: emiSchedules.paid_at,
        })
        .from(emiSchedules)
        .where(inArray(emiSchedules.loan_sanction_id, matchedLoanIds))
        .orderBy(emiSchedules.emi_seq);
      for (const s of sched) {
        const key = String(s.loan_sanction_id);
        const row: ScheduleRow = {
          id: s.id,
          emi_seq: s.emi_seq,
          due_date: String(s.due_date).slice(0, 10),
          status: s.status,
          paid_at: s.paid_at ? new Date(s.paid_at).toISOString() : null,
        };
        const arr = schedulesByLoan.get(key);
        if (arr) arr.push(row);
        else schedulesByLoan.set(key, [row]);
      }
    }

    for (const r of report) {
      if (!r.loanId) continue;
      const p = parsedByRow.get(r.rowNumber);
      const plan = planScheduleUpdates(p?.collections ?? [], schedulesByLoan.get(r.loanId) ?? []);
      r.scheduleUpdateCount = plan.updates.length;
      if (plan.unmatchedOrdinals.length > 0) {
        r.scheduleNote = `${plan.unmatchedOrdinals.length} collection(s) have no matching EMI installment and were skipped.`;
      }
    }

    if (mode === "validate") {
      return NextResponse.json({ ok: true, mode, report, summary: summarize(report) });
    }

    // ── Commit ────────────────────────────────────────────────────────────────
    const include = new Set(
      Array.isArray(body.includeRowNumbers)
        ? (body.includeRowNumbers as unknown[]).map(Number).filter((n) => Number.isFinite(n))
        : [],
    );

    // Applyable = operator-selected AND resolves to a single loan with no issues
    // (ready, or duplicate the operator chose to overwrite).
    const toApply = report.filter(
      (r) => include.has(r.rowNumber) && r.loanId != null && r.state !== "error",
    );

    // Standalone = operator explicitly force-imported an unmatched row (E-183):
    // no loan, so we write a display-only override row keyed by its own id.
    const standaloneInclude = new Set(
      Array.isArray(body.standaloneRowNumbers)
        ? (body.standaloneRowNumbers as unknown[]).map(Number).filter((n) => Number.isFinite(n))
        : [],
    );
    const toStandalone = report.filter(
      (r) => standaloneInclude.has(r.rowNumber) && r.noLoanMatch,
    );

    const results: ReportRow[] = report.map((r) => ({ ...r, applied: false }));
    const resultByRow = new Map(results.map((r) => [r.rowNumber, r]));

    let applied = 0;
    let standaloneApplied = 0; // display-only rows imported without a loan
    let scheduleUpdated = 0; // total installments flipped across all rows
    const now = new Date();

    await db.transaction(async (tx) => {
      for (const r of toApply) {
        const sp = makeSavepoint(r.rowNumber);
        await tx.execute(sql.raw(`SAVEPOINT ${sp}`));
        try {
          const d = r.derived;
          const values = {
            tenant_id: tenant.id,
            loan_application_id: r.loanId as string,
            borrower: d.borrower,
            vehicleno: d.vehicleno,
            emi: d.emi == null ? null : d.emi.toFixed(2),
            next_due: d.next_due,
            last_paid: d.last_paid,
            progress_paid: d.progress_paid,
            progress_total: d.progress_total,
            status: d.status,
            dpd: d.dpd,
            // Not present in the sheet — leave to computed fallback.
            mandate: null as string | null,
            next_auto_debit: null as string | null,
            financier: d.financier,
            updated_by: actorUserId,
            updated_at: now,
          };

          await tx
            .insert(nbfcEmiTrackerOverrides)
            .values(values)
            .onConflictDoUpdate({
              target: [
                nbfcEmiTrackerOverrides.tenant_id,
                nbfcEmiTrackerOverrides.loan_application_id,
              ],
              // Note: mandate / next_auto_debit are intentionally NOT in the
              // update set — they're not in the sheet, so an overwrite preserves
              // whatever a prior manual Edit set rather than wiping it.
              set: {
                borrower: values.borrower,
                vehicleno: values.vehicleno,
                emi: values.emi,
                next_due: values.next_due,
                last_paid: values.last_paid,
                progress_paid: values.progress_paid,
                progress_total: values.progress_total,
                status: values.status,
                dpd: values.dpd,
                financier: values.financier,
                updated_by: values.updated_by,
                updated_at: values.updated_at,
              },
            });

          // Schedule correction: flip the installments this row's collections
          // cover to Paid/Paid-Late in the canonical emi_schedules (mirrors the
          // per-EMI Edit route — status/paid_at/days_overdue only, audit-logged).
          const p = parsedByRow.get(r.rowNumber);
          const plan = planScheduleUpdates(p?.collections ?? [], schedulesByLoan.get(r.loanId as string) ?? []);
          for (const u of plan.updates) {
            await tx
              .update(emiSchedules)
              .set({
                status: u.newStatus,
                paid_at: new Date(`${u.newPaidAt}T00:00:00.000Z`),
                days_overdue: u.newDaysOverdue,
              })
              .where(eq(emiSchedules.id, u.emiId));

            await tx.insert(nbfcAuditLog).values({
              tenant_id: tenant.id,
              user_id: actorUserId,
              action_type: "emi_edit", // 8 chars — matches the per-EMI Edit path
              action_id: u.emiId,
              before_state: {
                emi_schedule_id: u.emiId,
                loan_sanction_id: r.loanId,
                status: u.prevStatus,
                source: "bulk_upload",
              },
              after_state: {
                emi_schedule_id: u.emiId,
                loan_sanction_id: r.loanId,
                emi_seq: u.emiSeq,
                due_date: u.dueDate,
                status: u.newStatus,
                paid_at: u.newPaidAt,
                days_overdue: u.newDaysOverdue,
                source: "bulk_upload",
              },
            });
          }
          scheduleUpdated += plan.updates.length;

          await tx.execute(sql.raw(`RELEASE SAVEPOINT ${sp}`));
          const res = resultByRow.get(r.rowNumber);
          if (res) {
            res.applied = true;
            res.scheduleUpdateCount = plan.updates.length;
          }
          applied += 1;
        } catch (rowError) {
          try {
            await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${sp}`));
            await tx.execute(sql.raw(`RELEASE SAVEPOINT ${sp}`));
          } catch {
            throw rowError;
          }
          const res = resultByRow.get(r.rowNumber);
          if (res) {
            res.applied = false;
            res.state = "error";
            res.issues.push({
              column: "row",
              value: "",
              message: rowError instanceof Error ? rowError.message : "Failed to apply this row.",
            });
          }
        }
      }

      // ── Standalone imports (E-183) ────────────────────────────────────────
      // Force-imported rows with no matching loan → a display-only override row
      // (loan_application_id NULL, is_standalone true) carrying all its values.
      // Deduped by (tenant, battery serial): re-importing the same serial
      // refreshes the existing standalone row rather than duplicating it.
      for (const r of toStandalone) {
        const sp = makeSavepoint(r.rowNumber);
        await tx.execute(sql.raw(`SAVEPOINT ${sp}`));
        try {
          const d = r.derived;
          const serialKey = normalizeSerial(d.vehicleno);
          if (serialKey) {
            await tx
              .delete(nbfcEmiTrackerOverrides)
              .where(
                and(
                  eq(nbfcEmiTrackerOverrides.tenant_id, tenant.id),
                  eq(nbfcEmiTrackerOverrides.is_standalone, true),
                  sql`lower(${nbfcEmiTrackerOverrides.vehicleno}) = ${serialKey}`,
                ),
              );
          }
          await tx.insert(nbfcEmiTrackerOverrides).values({
            tenant_id: tenant.id,
            loan_application_id: null,
            is_standalone: true,
            borrower: d.borrower,
            vehicleno: d.vehicleno,
            emi: d.emi == null ? null : d.emi.toFixed(2),
            next_due: d.next_due,
            last_paid: d.last_paid,
            progress_paid: d.progress_paid,
            progress_total: d.progress_total,
            status: d.status,
            dpd: d.dpd,
            mandate: null,
            next_auto_debit: null,
            financier: d.financier,
            updated_by: actorUserId,
            updated_at: now,
          });

          await tx.execute(sql.raw(`RELEASE SAVEPOINT ${sp}`));
          const res = resultByRow.get(r.rowNumber);
          if (res) {
            res.applied = true;
            res.state = "ready";
            res.note = "Imported as a standalone tracker entry.";
          }
          standaloneApplied += 1;
        } catch (rowError) {
          try {
            await tx.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${sp}`));
            await tx.execute(sql.raw(`RELEASE SAVEPOINT ${sp}`));
          } catch {
            throw rowError;
          }
          const res = resultByRow.get(r.rowNumber);
          if (res) {
            res.applied = false;
            res.issues.push({
              column: "row",
              value: "",
              message: rowError instanceof Error ? rowError.message : "Failed to import this row.",
            });
          }
        }
      }

      await tx.insert(nbfcAuditLog).values({
        tenant_id: tenant.id,
        user_id: actorUserId,
        action_type: "emi_tracker_bulk_upload", // 23 chars (≤ 32)
        after_state: {
          applied,
          standalone_imported: standaloneApplied,
          schedule_installments_updated: scheduleUpdated,
          selected: toApply.length + toStandalone.length,
          total: report.length,
          rows: results
            .filter((r) => r.applied)
            .map((r) => ({
              row: r.rowNumber,
              loan_sanction_id: r.loanId,
              emis_updated: r.scheduleUpdateCount,
            })),
        },
      });
    });

    // ── Cascade recompute ───────────────────────────────────────────────────
    // The schedule writes above changed the inputs to DPD aging + CDS + PCI, all
    // of which read emi_schedules. Refresh them so the portfolio/battery/lead
    // pages don't show a stale snapshot. Best-effort: a recompute failure must
    // not fail an upload that already committed.
    const recompute = { dpd: false, cds: false, pci: false, error: null as string | null };
    if (scheduleUpdated > 0) {
      try {
        await runEmiAging();
        recompute.dpd = true;
      } catch (e) {
        recompute.error = e instanceof Error ? e.message : String(e);
      }
      try {
        await runCdsNightlyJob();
        recompute.cds = true;
      } catch (e) {
        recompute.error = e instanceof Error ? e.message : String(e);
      }
      try {
        await computePciForAllLoans({ tenantId: tenant.id });
        recompute.pci = true;
      } catch (e) {
        recompute.error = e instanceof Error ? e.message : String(e);
      }
    }

    return NextResponse.json({
      ok: true,
      mode,
      applied,
      standaloneApplied,
      scheduleUpdated,
      skipped: report.length - applied - standaloneApplied,
      recompute,
      report: results,
      summary: summarize(results),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.startsWith("BAD_REQUEST")
      ? 400
      : msg.includes("FORBIDDEN") || msg.includes("not allowed")
        ? 403
        : msg.startsWith("UNAUTHORIZED")
          ? 401
          : 500;
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status });
  }
}
