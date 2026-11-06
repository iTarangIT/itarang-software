/**
 * ID 204 (Kartik, 4 Nov) — every recorded payment is settled oldest-EMI-first,
 * not only the portal's "Record payment": the Razorpay webhook, the auto-debit
 * (simulate) run and the EMI-tracker Excel upload come through here.
 *
 * Given the EMI a collection was raised for and the amount collected, the
 * money goes to the loan's unpaid EMIs due on or before that EMI, oldest
 * first (applyLoanPaymentFifo). It is capped at what is owed up to that EMI, so
 * a collection never pre-pays a later month and a rounding paisa over the due
 * does not refuse the whole payment. With no usable amount (an event without
 * one) the target EMI is settled in full, as before.
 *
 * Runs inside the caller's transaction. `recordSliceAttempts` writes one
 * ledger row for each EMI the money reached other than the target (whose own
 * attempt row the caller updates), so each EMI's history shows what it got.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { emiPaymentAttempts } from "@/lib/db/schema";
import { applyEmiPayment } from "./applyEmiPayment";
import { applyLoanPaymentFifo, owedUpTo } from "./applyLoanPaymentFifo";

type TxLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

export interface SettledPayment {
    applied: boolean;
    reason?: string;
    /** Oldest first. */
    slices: Array<{ emiId: string; amount: number }>;
    totalApplied: number;
    loanClosed: boolean;
    loanSanctionId: string | null;
    /** The last EMI the money reached — "EMI received" names its next due. */
    lastEmiId: string | null;
    /** Status of the target EMI after settlement (for the caller's response). */
    targetStatus: string | null;
}

/** Rupees, or null when not a positive number. Pure. */
export function collectedRupees(v: unknown, unit: "paise" | "rupees"): number | null {
    const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
    if (!Number.isFinite(n) || n <= 0) return null;
    return unit === "paise" ? Math.round(n) / 100 : Math.round(n * 100) / 100;
}

export async function settleCollectedPaymentFifo(
    tx: TxLike,
    input: {
        targetEmiId: string;
        amount: number | null;
        paymentRef: string | null;
        paidAt: Date;
        mode: string;
        channel: string;
        documentUrl?: string | null;
        actorUserId?: string;
    },
): Promise<SettledPayment> {
    const [target] = rowsOf<{ loan_sanction_id: string; due_date: string }>(
        await tx.execute(sql`
            SELECT loan_sanction_id, due_date::text AS due_date FROM emi_schedules WHERE id = ${input.targetEmiId}::uuid
        `),
    );
    const none: SettledPayment = {
        applied: false,
        slices: [],
        totalApplied: 0,
        loanClosed: false,
        loanSanctionId: target?.loan_sanction_id ?? null,
        lastEmiId: null,
        targetStatus: null,
    };
    if (!target) return { ...none, reason: "emi_not_found" };

    if (input.amount == null) {
        // No amount on the event: settle the target EMI in full, as before.
        const r = await applyEmiPayment(tx, {
            emiId: input.targetEmiId,
            paymentRef: input.paymentRef,
            paidAt: input.paidAt,
            mode: input.mode,
            channel: input.channel,
            documentUrl: input.documentUrl ?? null,
            actorUserId: input.actorUserId,
        });
        if (!r.applied) return { ...none, reason: r.reason };
        return {
            ...none,
            applied: true,
            slices: [{ emiId: input.targetEmiId, amount: r.amountPaid ?? 0 }],
            totalApplied: r.amountPaid ?? 0,
            loanClosed: !!r.loanClosed,
            lastEmiId: input.targetEmiId,
            targetStatus: r.status ?? null,
        };
    }

    const dueDate = target.due_date.slice(0, 10);
    const owed = await owedUpTo(tx, target.loan_sanction_id, dueDate);
    const amount = Math.min(input.amount, owed);
    if (amount <= 0) return { ...none, reason: "already_paid" };

    const r = await applyLoanPaymentFifo(tx, {
        loanSanctionId: target.loan_sanction_id,
        upToDueDate: dueDate,
        amount,
        paymentRef: input.paymentRef,
        paidAt: input.paidAt,
        mode: input.mode,
        channel: input.channel,
        documentUrl: input.documentUrl ?? null,
        actorUserId: input.actorUserId,
    });
    if (!r.applied) return { ...none, reason: r.reason };
    const targetSlice = r.slices.find((s) => s.emiId === input.targetEmiId);
    return {
        ...none,
        applied: true,
        slices: r.slices.map((s) => ({ emiId: s.emiId, amount: s.amount })),
        totalApplied: r.totalApplied,
        loanClosed: r.loanClosed,
        lastEmiId: r.slices[r.slices.length - 1]?.emiId ?? null,
        targetStatus: targetSlice?.result.status ?? null,
    };
}

/**
 * One succeeded ledger row per EMI the money reached other than the target.
 * The tenant comes from the target's attempt row when given, else the loan's
 * other attempts. Idempotent: the key is `${keyPrefix}:${emiId}`.
 */
export async function recordSliceAttempts(
    tx: TxLike,
    input: {
        settled: SettledPayment;
        targetEmiId: string;
        keyPrefix: string;
        mode: string;
        channel: string;
        paidAt: Date;
        tenantId: string | null;
        razorpayPaymentId?: string | null;
        note: string;
    },
): Promise<void> {
    const others = input.settled.slices.filter((s) => s.emiId !== input.targetEmiId);
    if (others.length === 0 || !input.settled.loanSanctionId || !input.tenantId) return;
    for (const s of others) {
        await tx
            .insert(emiPaymentAttempts)
            .values({
                emi_schedule_id: s.emiId,
                loan_sanction_id: input.settled.loanSanctionId,
                tenant_id: input.tenantId,
                idempotency_key: `${input.keyPrefix}:${s.emiId}`.slice(0, 80),
                mode: input.mode,
                channel: input.channel,
                amount_paise: Math.round(s.amount * 100),
                status: "succeeded",
                razorpay_payment_id: input.razorpayPaymentId ?? null,
                collected_at: input.paidAt,
                note: input.note,
            })
            .onConflictDoNothing();
    }
}

/** The tenant of an attempt row, for recordSliceAttempts. */
export async function attemptTenant(tx: TxLike, attemptId: string | null): Promise<string | null> {
    if (!attemptId) return null;
    const [r] = rowsOf<{ tenant_id: string | null }>(
        await tx.execute(sql`SELECT tenant_id::text AS tenant_id FROM emi_payment_attempts WHERE id = ${attemptId}::uuid`),
    );
    return r?.tenant_id ?? null;
}
