/**
 * applyLoanPaymentFifo — one collected payment, settled oldest-EMI-first
 * (3 Nov). Customer missed January and February and pays in March: the money
 * clears January, then February, then March; whatever is not covered stays
 * pending on the later EMIs.
 *
 * Each slice goes through applyEmiPayment, so status / outstanding / DPD /
 * loan close / audit behave exactly as before. Runs inside the caller's
 * transaction and locks the loan's unpaid EMI rows first, so two collections
 * on the same loan cannot both take the same slice.
 *
 * `upToDueDate` bounds the walk: only EMIs due on or before it are paid
 * (the EMI the collector opened). A payment never pre-pays a later month.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { applyEmiPayment, type ApplyEmiPaymentResult } from "./applyEmiPayment";
import { allocateFifo, totalOwedPaise, type OpenEmi } from "./fifo";

type TxLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

export interface ApplyLoanPaymentFifoInput {
  loanSanctionId: string;
  /** YYYY-MM-DD — only EMIs due on or before this date are paid. */
  upToDueDate: string;
  /** Rupees collected. */
  amount: number;
  paymentRef: string | null;
  paidAt: Date;
  mode: string;
  channel: string;
  documentUrl?: string | null;
  actorUserId?: string;
}

export interface ApplyLoanPaymentFifoResult {
  applied: boolean;
  reason?: string;
  /** One entry per EMI the money went to, oldest first. */
  slices: Array<{ emiId: string; amount: number; result: ApplyEmiPaymentResult }>;
  /** Rupees actually applied. */
  totalApplied: number;
  loanClosed: boolean;
}

/** The loan's unpaid EMIs due on or before `upToDueDate`, oldest first, row-locked. */
export async function lockOpenEmis(tx: TxLike, loanSanctionId: string, upToDueDate: string): Promise<OpenEmi[]> {
  const rows = rowsOf<{ id: string; due_date: string; remaining_paise: string | number }>(
    await tx.execute(sql`
      SELECT id::text AS id, due_date::text AS due_date,
             ROUND((COALESCE(amount, 0) - COALESCE(amount_paid, 0)) * 100) AS remaining_paise
        FROM emi_schedules
       WHERE loan_sanction_id = ${loanSanctionId}
         AND status IN ('scheduled', 'overdue', 'missed')
         AND due_date <= ${upToDueDate}::date
         AND COALESCE(amount_paid, 0) < COALESCE(amount, 0)
       ORDER BY due_date, emi_seq NULLS LAST, id
       FOR UPDATE
    `),
  );
  return rows.map((r) => ({ id: r.id, dueDate: r.due_date.slice(0, 10), remainingPaise: Number(r.remaining_paise) }));
}

/** Rupees owed on the loan's unpaid EMIs due on or before `upToDueDate` (the most one collection may take). */
export async function owedUpTo(tx: TxLike, loanSanctionId: string, upToDueDate: string): Promise<number> {
  const rows = rowsOf<{ owed: string | null }>(
    await tx.execute(sql`
      SELECT COALESCE(SUM(COALESCE(amount, 0) - COALESCE(amount_paid, 0)), 0)::text AS owed
        FROM emi_schedules
       WHERE loan_sanction_id = ${loanSanctionId}
         AND status IN ('scheduled', 'overdue', 'missed')
         AND due_date <= ${upToDueDate}::date
         AND COALESCE(amount_paid, 0) < COALESCE(amount, 0)
    `),
  );
  return Math.round(Number(rows[0]?.owed ?? 0) * 100) / 100;
}

export async function applyLoanPaymentFifo(
  tx: TxLike,
  input: ApplyLoanPaymentFifoInput,
): Promise<ApplyLoanPaymentFifoResult> {
  const open = await lockOpenEmis(tx, input.loanSanctionId, input.upToDueDate);
  const amountPaise = Math.round(input.amount * 100);
  if (amountPaise <= 0) return { applied: false, reason: "invalid_amount", slices: [], totalApplied: 0, loanClosed: false };
  if (open.length === 0) return { applied: false, reason: "already_paid", slices: [], totalApplied: 0, loanClosed: false };
  if (amountPaise > totalOwedPaise(open)) {
    return { applied: false, reason: "exceeds_due", slices: [], totalApplied: 0, loanClosed: false };
  }

  const { allocations } = allocateFifo(open, amountPaise);
  const slices: ApplyLoanPaymentFifoResult["slices"] = [];
  let loanClosed = false;
  for (const a of allocations) {
    const result = await applyEmiPayment(tx, {
      emiId: a.id,
      paymentAmount: a.paise / 100,
      paymentRef: input.paymentRef,
      paidAt: input.paidAt,
      mode: input.mode,
      channel: input.channel,
      documentUrl: input.documentUrl ?? null,
      actorUserId: input.actorUserId,
    });
    // Rows are locked and the amounts come from them — a slice that does not
    // apply means the data moved under us; abort the whole payment.
    if (!result.applied) throw new Error(`FIFO slice on EMI ${a.id} not applied: ${result.reason ?? "unknown"}`);
    slices.push({ emiId: a.id, amount: a.paise / 100, result });
    loanClosed = loanClosed || !!result.loanClosed;
  }
  return {
    applied: true,
    slices,
    totalApplied: allocations.reduce((s, a) => s + a.paise, 0) / 100,
    loanClosed,
  };
}
