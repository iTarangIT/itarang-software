/**
 * POST /api/nbfc/loans/[loanSanctionId]/emi/[emiId]/record-payment
 *
 * Manual collection entry for an EMI installment — cash / UPI / bank transfer /
 * cheque / QR. Supports PARTIAL payments (a ₹5,250 EMI paid ₹3,000 leaves
 * ₹2,250 due; the installment stays open and further collections accumulate).
 * An optional invoice/receipt document can be attached.
 *
 * Accepts multipart/form-data:
 *   amount     (rupees, required, 0 < amount <= remaining)
 *   mode       ('cash' | 'upi' | 'bank_transfer' | 'cheque' | 'qr', required)
 *   paid_at    (ISO/date, optional — defaults to now, must not be in the future)
 *   reference  (optional txn id / UPI ref / cheque no.)
 *   note       (optional)
 *   file       (optional receipt: pdf/jpg/png, <= 10 MB)
 *
 * Tenant-scoped. Routes through the shared applyEmiPayment settlement path so
 * manual collections behave identically to auto-debit (outstanding update, loan
 * close on final EMI, immutable audit log).
 */
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { clientError } from "@/lib/nbfc/http-error";
import { emiPaymentAttempts, emiSchedules, nbfcLoans } from "@/lib/db/schema";
import { getCurrentTenant, requireNbfcAccess } from "@/lib/nbfc/tenant";
import { putNbfcObject } from "@/lib/nbfc/nbfc-storage";
import { applyEmiPayment, SYSTEM_USER_ID } from "@/lib/nbfc/servicing/applyEmiPayment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_MODES = new Set(["cash", "upi", "bank_transfer", "cheque", "qr"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXT: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

function isPdf(buf: Buffer): boolean {
  // %PDF- — file.type is client-supplied and untrustworthy.
  return (
    buf.length >= 5 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46 &&
    buf[4] === 0x2d
  );
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ loanSanctionId: string; emiId: string }> },
) {
  try {
    const tenant = await getCurrentTenant();
    const session = await requireNbfcAccess(tenant.id);
    const actorUserId = "id" in session ? session.id : SYSTEM_USER_ID;

    const { loanSanctionId, emiId } = await ctx.params;
    if (!loanSanctionId || !emiId) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: loanSanctionId and emiId required" },
        { status: 400 },
      );
    }

    // Tenant ownership of the loan.
    const [owner] = await db
      .select({ tenant_id: nbfcLoans.tenant_id })
      .from(nbfcLoans)
      .where(
        and(
          eq(nbfcLoans.loan_application_id, loanSanctionId),
          eq(nbfcLoans.tenant_id, tenant.id),
        ),
      )
      .limit(1);
    if (!owner) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: loan not found for this tenant" },
        { status: 404 },
      );
    }

    // The EMI must belong to that loan; pull due + collected so far.
    const [emi] = await db
      .select({
        id: emiSchedules.id,
        status: emiSchedules.status,
        amount: emiSchedules.amount,
        amount_paid: emiSchedules.amount_paid,
      })
      .from(emiSchedules)
      .where(and(eq(emiSchedules.id, emiId), eq(emiSchedules.loan_sanction_id, loanSanctionId)))
      .limit(1);
    if (!emi) {
      return NextResponse.json(
        { ok: false, error: "NOT_FOUND: EMI not found for this loan" },
        { status: 404 },
      );
    }

    // ---- Parse multipart body ------------------------------------------------
    const form = await req.formData();
    const amount = Number(form.get("amount"));
    const mode = String(form.get("mode") ?? "").trim();
    const paidAtRaw = (form.get("paid_at") as string | null)?.trim() || null;
    const reference = (form.get("reference") as string | null)?.trim() || null;
    const note = (form.get("note") as string | null)?.trim() || null;
    const file = form.get("file");

    if (!ALLOWED_MODES.has(mode)) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid payment mode" },
        { status: 400 },
      );
    }

    const due = emi.amount != null ? Number(emi.amount) : 0;
    const paidSoFar = emi.amount_paid != null ? Number(emi.amount_paid) : 0;
    const remaining = Math.max(0, Math.round((due - paidSoFar) * 100) / 100);
    if (remaining <= 0 || emi.status === "paid" || emi.status === "paid_late") {
      return NextResponse.json(
        { ok: false, error: "CONFLICT: EMI is already fully paid" },
        { status: 409 },
      );
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: amount must be greater than 0" },
        { status: 400 },
      );
    }
    if (amount > remaining + 0.001) {
      return NextResponse.json(
        { ok: false, error: `BAD_REQUEST: amount exceeds remaining due (₹${remaining})` },
        { status: 400 },
      );
    }

    const now = new Date();
    const paidAt = paidAtRaw ? new Date(paidAtRaw) : now;
    if (Number.isNaN(paidAt.getTime())) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid paid_at" }, { status: 400 });
    }
    if (paidAt.getTime() > now.getTime() + 60_000) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: paid_at cannot be in the future" },
        { status: 400 },
      );
    }

    // ---- Optional receipt upload --------------------------------------------
    let documentUrl: string | null = null;
    if (file && typeof file === "object" && "arrayBuffer" in file) {
      const f = file as File;
      if (f.size > MAX_FILE_BYTES) {
        return NextResponse.json(
          { ok: false, error: "BAD_REQUEST: file exceeds 10MB" },
          { status: 413 },
        );
      }
      const ext = (f.name.split(".").pop() ?? "").toLowerCase();
      const contentType = ALLOWED_EXT[ext];
      if (!contentType) {
        return NextResponse.json(
          { ok: false, error: "BAD_REQUEST: only PDF, JPG or PNG receipts are accepted" },
          { status: 415 },
        );
      }
      const buf = Buffer.from(await f.arrayBuffer());
      if (ext === "pdf" && !isPdf(buf)) {
        return NextResponse.json(
          { ok: false, error: "BAD_REQUEST: file is not a valid PDF" },
          { status: 415 },
        );
      }
      const key = `emi-receipts/${loanSanctionId}/${emiId}/${now.getTime()}.${ext}`;
      const { url } = await putNbfcObject(key, buf, contentType);
      documentUrl = url;
    }

    const amountPaise = Math.round(amount * 100);
    const refForSchedule = reference ? `${mode.toUpperCase()}:${reference}` : `${mode}`;

    const result = await db.transaction(async (tx) => {
      // Record the collection event for the audit ledger.
      await tx.insert(emiPaymentAttempts).values({
        emi_schedule_id: emiId,
        loan_sanction_id: loanSanctionId,
        tenant_id: tenant.id,
        idempotency_key: `manual:${emiId}:${now.getTime()}`,
        mode: "manual",
        channel: mode,
        amount_paise: amountPaise,
        status: "succeeded",
        reference_no: reference,
        document_url: documentUrl,
        collected_at: paidAt,
        note,
        actor_user_id: actorUserId,
      });
      return applyEmiPayment(tx, {
        emiId,
        paymentAmount: amount,
        paymentRef: refForSchedule,
        paidAt,
        mode: "manual",
        channel: mode,
        documentUrl,
        actorUserId,
      });
    });

    if (!result.applied) {
      return NextResponse.json(
        { ok: false, error: `CONFLICT: ${result.reason ?? "not applied"}` },
        { status: 409 },
      );
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.includes("FORBIDDEN")
      ? 403
      : msg.startsWith("UNAUTHORIZED")
        ? 401
        : 500;
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status });
  }
}
