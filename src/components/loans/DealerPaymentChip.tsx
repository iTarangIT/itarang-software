/**
 * E-298 — "Dealer payment: Received ✓ / Not received ✗ / Pending" chip for the
 * NBFC Acquire lead detail and the admin lead review page.
 *
 * Async SERVER component (reads the DB directly). Renders nothing until the
 * sanction has entered the confirmation loop at dispatch, and nothing on a host
 * without E-298 (the read fails soft).
 */
import { and, desc, eq, isNotNull, isNull, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { loanSanctions } from "@/lib/db/schema";

function fmtWhen(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default async function DealerPaymentChip({
  leadId,
  tenantId,
}: {
  leadId: string;
  /** NBFC view: only the sanction this tenant wrote. Omit for admin. */
  tenantId?: string | null;
}) {
  let row:
    | {
        status: string | null;
        at: Date | null;
        utr: string | null;
        remarks: string | null;
      }
    | undefined;
  try {
    const conds = [eq(loanSanctions.lead_id, leadId), isNotNull(loanSanctions.dealer_payment_status)];
    // A competing lender must not see another lender's payout; admin- or
    // externally-sanctioned rows carry no nbfc_id and stay visible.
    if (tenantId) conds.push(or(eq(loanSanctions.nbfc_id, tenantId), isNull(loanSanctions.nbfc_id))!);
    [row] = await db
      .select({
        status: loanSanctions.dealer_payment_status,
        at: loanSanctions.dealer_payment_confirmed_at,
        utr: loanSanctions.dealer_payment_utr,
        remarks: loanSanctions.dealer_payment_remarks,
      })
      .from(loanSanctions)
      .where(and(...conds))
      .orderBy(desc(loanSanctions.created_at))
      .limit(1);
  } catch {
    return null;
  }
  if (!row?.status) return null;

  const style =
    row.status === "received"
      ? { cls: "bg-emerald-50 border-emerald-200 text-emerald-800", label: "Dealer payment: Received ✓" }
      : row.status === "not_received"
        ? { cls: "bg-red-50 border-red-200 text-red-800", label: "Dealer payment: Not received ✗" }
        : { cls: "bg-amber-50 border-amber-200 text-amber-800", label: "Dealer payment: Pending" };

  const detail = [
    row.at ? fmtWhen(row.at) : null,
    row.utr ? `UTR ${row.utr}` : null,
    row.remarks,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold ${style.cls}`}
      title={detail || undefined}
    >
      {style.label}
      {detail ? <span className="font-normal opacity-80 hidden sm:inline">· {detail}</span> : null}
    </span>
  );
}
