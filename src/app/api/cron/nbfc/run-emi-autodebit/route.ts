/**
 * Daily cron — automated EMI collection (E-NACH auto-debit).
 *
 * For every EMI due on/before today and still unpaid, attempts collection:
 *   - registered E-NACH mandate → auto-debit via Razorpay (LIVE), or mark paid
 *     against the schedule without charging anything (SIMULATE).
 *   - no mandate → generate a UPI payment link as a fallback (LIVE) / log only
 *     (SIMULATE). Settlement of the link is handled by the QR webhook / manual
 *     record-payment, not here.
 *
 * SAFETY:
 *   - MODE = EMI_AUTODEBIT_MODE ('simulate' default | 'live'). Default never
 *     moves real money — a misconfigured deploy cannot debit accounts.
 *   - Double-debit guard: a deterministic per-(emi, cycle) idempotency key with
 *     a UNIQUE index; the claiming INSERT ... ON CONFLICT DO NOTHING means
 *     overlapping ticks can attempt an EMI at most once per day.
 *   - LIVE charges are capped by the mandate's max_amount / valid_to window and
 *     an optional EMI_AUTODEBIT_MAX_PAISE ceiling.
 *   - LIVE never marks the EMI paid here — the emi-webhook is source of truth.
 *
 * Schedule: vercel.json "0 6 * * *" (after run-emi-aging at 05:30). Auth:
 * Vercel cron header OR Bearer CRON_SECRET; unauthenticated allowed non-prod.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  emiPaymentAttempts,
  emiSchedules,
  enachMandates,
  leads,
  loanSanctions,
  nbfcLoans,
} from "@/lib/db/schema";
import { createPaymentQr, createRecurringDebit, razorpayErrorMessage } from "@/lib/razorpay";
import { applyEmiPayment } from "@/lib/nbfc/servicing/applyEmiPayment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PAISE_CEILING = process.env.EMI_AUTODEBIT_MAX_PAISE
  ? Number(process.env.EMI_AUTODEBIT_MAX_PAISE)
  : null;

function isAuthorised(req: NextRequest): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && auth === `Bearer ${expected}`) return true;
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

interface Summary {
  mode: string;
  due: number;
  debited: number;
  simulated: number;
  fallback_link: number;
  skipped: number;
  failed: number;
}

async function run(): Promise<Summary> {
  const MODE = (process.env.EMI_AUTODEBIT_MODE ?? "simulate").toLowerCase();
  const now = new Date();
  const cycleDate = now.toISOString().slice(0, 10);

  const summary: Summary = {
    mode: MODE,
    due: 0,
    debited: 0,
    simulated: 0,
    fallback_link: 0,
    skipped: 0,
    failed: 0,
  };

  // Due, unpaid installments on active, not-yet-closed loans.
  const dueEmis = await db
    .select({
      emiId: emiSchedules.id,
      emiAmount: emiSchedules.amount,
      dueDate: emiSchedules.due_date,
      loanId: emiSchedules.loan_sanction_id,
      leadId: loanSanctions.lead_id,
      fallbackEmi: loanSanctions.emi,
      tenantId: nbfcLoans.tenant_id,
    })
    .from(emiSchedules)
    .innerJoin(loanSanctions, eq(loanSanctions.id, emiSchedules.loan_sanction_id))
    .innerJoin(nbfcLoans, eq(nbfcLoans.loan_application_id, emiSchedules.loan_sanction_id))
    .where(
      and(
        inArray(emiSchedules.status, ["scheduled", "overdue"]),
        lte(emiSchedules.due_date, cycleDate),
        eq(nbfcLoans.is_active, true),
        isNull(loanSanctions.closed_at),
      ),
    )
    .orderBy(asc(emiSchedules.due_date));

  summary.due = dueEmis.length;

  for (const emi of dueEmis) {
    try {
      const amountInr =
        emi.emiAmount != null
          ? Number(emi.emiAmount)
          : emi.fallbackEmi != null
            ? Number(emi.fallbackEmi)
            : 0;
      if (!(amountInr > 0)) {
        summary.skipped++;
        continue;
      }
      const amountPaise = Math.round(amountInr * 100);

      // Look up a usable registered mandate (read-only) to decide the channel.
      const [mandate] = await db
        .select({
          customerId: enachMandates.razorpay_customer_id,
          tokenId: enachMandates.razorpay_token_id,
          maxAmount: enachMandates.max_amount,
          validTo: enachMandates.valid_to,
        })
        .from(enachMandates)
        .where(
          and(
            eq(enachMandates.lead_id, emi.leadId),
            eq(enachMandates.tenant_id, emi.tenantId),
            eq(enachMandates.status, "registered"),
          ),
        )
        .limit(1);

      const hasMandate = Boolean(mandate?.customerId && mandate?.tokenId);
      const channel: "enach" | "upi_link" = hasMandate ? "enach" : "upi_link";

      // Claim the idempotency slot. ON CONFLICT DO NOTHING → loser skips.
      const [attempt] = await db
        .insert(emiPaymentAttempts)
        .values({
          emi_schedule_id: emi.emiId,
          loan_sanction_id: emi.loanId,
          tenant_id: emi.tenantId,
          idempotency_key: `emi:${emi.emiId}:${cycleDate}`,
          mode: MODE,
          channel,
          razorpay_customer_id: mandate?.customerId ?? null,
          razorpay_token_id: mandate?.tokenId ?? null,
          amount_paise: amountPaise,
          status: "initiated",
        })
        .onConflictDoNothing({ target: emiPaymentAttempts.idempotency_key })
        .returning({ id: emiPaymentAttempts.id });

      if (!attempt) {
        summary.skipped++; // already attempted this cycle
        continue;
      }

      // Telemetry on the schedule row regardless of outcome.
      await db
        .update(emiSchedules)
        .set({ attempt_count: sql`${emiSchedules.attempt_count} + 1`, last_attempt_at: now })
        .where(eq(emiSchedules.id, emi.emiId));

      // ---- E-NACH path ---------------------------------------------------
      if (channel === "enach" && mandate) {
        // Mandate ceilings (LIVE-relevant; enforce always for safety).
        const overMandate =
          mandate.maxAmount != null && amountInr > Number(mandate.maxAmount);
        const overCeiling = MAX_PAISE_CEILING != null && amountPaise > MAX_PAISE_CEILING;
        const expired = mandate.validTo != null && mandate.validTo < cycleDate;
        if (overMandate || overCeiling || expired) {
          await db
            .update(emiPaymentAttempts)
            .set({
              status: "failed",
              failure_reason: overMandate
                ? "amount exceeds mandate max_amount"
                : overCeiling
                  ? "amount exceeds EMI_AUTODEBIT_MAX_PAISE"
                  : "mandate expired (valid_to)",
              updated_at: now,
            })
            .where(eq(emiPaymentAttempts.id, attempt.id));
          summary.failed++;
          continue;
        }

        if (MODE === "live") {
          try {
            const result = await createRecurringDebit({
              customerId: mandate.customerId as string,
              tokenId: mandate.tokenId as string,
              amountPaise,
              idempotencyKey: `emi:${emi.emiId}:${cycleDate}`,
              notes: {
                purpose: "emi_debit",
                emi_schedule_id: emi.emiId,
                loan_sanction_id: emi.loanId,
              },
            });
            await db
              .update(emiPaymentAttempts)
              .set({
                status: "submitted",
                razorpay_payment_id: result.paymentId || null,
                provider_raw_status: result.status,
                updated_at: now,
              })
              .where(eq(emiPaymentAttempts.id, attempt.id));
            // Do NOT mark paid here — the emi-webhook settles it.
            summary.debited++;
          } catch (err) {
            await db
              .update(emiPaymentAttempts)
              .set({ status: "failed", failure_reason: razorpayErrorMessage(err), updated_at: now })
              .where(eq(emiPaymentAttempts.id, attempt.id));
            summary.failed++;
          }
        } else {
          // SIMULATE — no Razorpay call; drive the full settlement pipeline.
          console.log(
            `[emi-autodebit][SIMULATE] would debit ₹${amountInr} for emi ${emi.emiId} (loan ${emi.loanId})`,
          );
          await db
            .update(emiPaymentAttempts)
            .set({ status: "simulated", updated_at: now })
            .where(eq(emiPaymentAttempts.id, attempt.id));
          await db.transaction((tx) =>
            applyEmiPayment(tx, {
              emiId: emi.emiId,
              paymentRef: `SIM-${attempt.id}`,
              paidAt: now,
              mode: "simulate",
              channel: "enach",
            }),
          );
          summary.simulated++;
        }
        continue;
      }

      // ---- No-mandate fallback: UPI link --------------------------------
      if (MODE === "live") {
        try {
          const [lead] = await db
            .select({ name: leads.full_name })
            .from(leads)
            .where(eq(leads.id, emi.leadId))
            .limit(1);
          const qr = await createPaymentQr({
            amount: amountInr,
            leadId: emi.leadId,
            customerName: lead?.name ?? "Borrower",
            description: `EMI payment — loan ${emi.loanId}`,
          });
          await db
            .update(emiPaymentAttempts)
            .set({
              status: "submitted",
              provider_raw_status: qr.short_url || qr.id,
              updated_at: now,
            })
            .where(eq(emiPaymentAttempts.id, attempt.id));
        } catch (err) {
          await db
            .update(emiPaymentAttempts)
            .set({ status: "failed", failure_reason: razorpayErrorMessage(err), updated_at: now })
            .where(eq(emiPaymentAttempts.id, attempt.id));
          summary.failed++;
          continue;
        }
      } else {
        console.log(
          `[emi-autodebit][SIMULATE] no mandate — would send UPI link for ₹${amountInr}, emi ${emi.emiId}`,
        );
        await db
          .update(emiPaymentAttempts)
          .set({ status: "simulated", updated_at: now })
          .where(eq(emiPaymentAttempts.id, attempt.id));
      }
      summary.fallback_link++;
    } catch (err) {
      console.error("[emi-autodebit] EMI failed:", emi.emiId, err);
      summary.failed++;
    }
  }

  return summary;
}

async function handle(req: NextRequest) {
  if (!isAuthorised(req)) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }
  try {
    const result = await run();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[run-emi-autodebit] Error:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
