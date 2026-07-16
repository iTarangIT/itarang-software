/**
 * GET /api/admin/buyback/requests/:id/documents   (M15 — the document centre)
 *
 * Every document a deal produces, in one place, with its DIRECTION — who issued
 * it to whom. That direction matrix is the point: on a back-to-back trade the same
 * word ("invoice") means two opposite things depending on which leg you are
 * standing on, and an auditor asked to reconstruct the deal needs to be told which
 * is which.
 *
 * M15's AC is "every CLOSED deal has the full set", so this endpoint does not just
 * list what exists — it reports what is MISSING, and whether the set is complete.
 * A document centre that only shows you the documents you have is exactly no help
 * for the question you actually have, which is "what am I missing?".
 *
 * NOTE — M15 appears in no sprint row of the BRD's §9 table. It was simply left
 * out of the plan. It is built here because the Sprint 2 exit criteria depend on
 * it (a CLOSED deal must be provably complete) and because every document it lists
 * already exists and is keyed; without this they are simply unreachable.
 */

import { sql } from "drizzle-orm";

import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { loadAnyRequest, requireBuybackAdmin } from "@/lib/buyback/auth";
import { NotFoundError } from "@/lib/buyback/errors";
import { dealHeader } from "@/lib/buyback/queries";

/**
 * Build the authenticated evidence link (U1) rather than filesProxyPath. That
 * proxy (src/lib/storage/s3.ts) is DELIBERATELY unauthenticated — it exists for
 * the pre-login dealer onboarding flow — and buyback documents include a
 * previous owner's identity documents and a signed settlement proof; minting
 * an unauthenticated link for those would mean anyone holding it could read
 * them, forever, with no session. /api/buyback/media checks the caller against
 * the request before serving the object — see that route's header comment.
 */
function evidenceHref(key: string | null): string | null {
  return key ? `/api/buyback/media?evidence=${encodeURIComponent(key)}` : null;
}

export const runtime = "nodejs";

type Direction = "ITARANG_TO_DEALER" | "DEALER_TO_ITARANG" | "ITARANG_TO_VENDOR" | "VENDOR_TO_ITARANG";

interface DocumentEntry {
  kind: string;
  label: string;
  direction: Direction;
  number: string | null;
  status: string | null;
  s3_key: string | null;
  href: string | null;
  present: boolean;
}

/** Which documents a deal MUST have by the time it is CLOSED (M15 AC). */
const REQUIRED_WHEN_CLOSED = [
  "quotation",
  "po_dealer",
  "po_vendor",
  "invoice_dealer",
  "invoice_vendor",
  "proof_dealer",
  "proof_vendor",
];

export const GET = withErrorHandler(
  async (_req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const { id: requestId } = await ctx.params;
    await requireBuybackAdmin();
    const request = await loadAnyRequest(requestId);

    const header = await dealHeader(request.id);
    if (!header) throw new NotFoundError("Deal not found.");

    const docs: DocumentEntry[] = [];

    const add = (
      kind: string,
      label: string,
      direction: Direction,
      s3_key: string | null,
      number: string | null = null,
      status: string | null = null,
    ) => {
      docs.push({
        kind,
        label,
        direction,
        number,
        status,
        s3_key,
        href: evidenceHref(s3_key),
        present: Boolean(s3_key),
      });
    };

    // --- Quotations (one per vendor we approached) ---------------------------
    const threads = (await db.execute(sql`
      SELECT vt.quotation_no, vt.quotation_pdf_s3, vt.status,
             a.business_entity_name AS vendor
      FROM vendor_threads vt
      JOIN scrap_vendors sv ON sv.id = vt.vendor_id
      JOIN accounts a       ON a.id = sv.entity_id
      WHERE vt.deal_id = ${header.deal_id}
      ORDER BY vt.created_at
    `)) as unknown as Array<{
      quotation_no: string | null;
      quotation_pdf_s3: string | null;
      status: string;
      vendor: string;
    }>;

    for (const t of threads) {
      add(
        "quotation",
        `Quotation → ${t.vendor}`,
        "ITARANG_TO_VENDOR",
        t.quotation_pdf_s3,
        t.quotation_no,
        t.status,
      );
    }
    if (threads.length === 0) {
      add("quotation", "Quotation → vendors", "ITARANG_TO_VENDOR", null);
    }

    // --- Purchase orders -----------------------------------------------------
    const pos = (await db.execute(sql`
      SELECT leg, direction, number, pdf_s3, status
      FROM purchase_orders WHERE deal_id = ${header.deal_id}
    `)) as unknown as Array<{
      leg: string;
      direction: string;
      number: string;
      pdf_s3: string | null;
      status: string;
    }>;

    const dealerPo = pos.find((p) => p.leg === "DEALER");
    const vendorPo = pos.find((p) => p.leg === "VENDOR");

    add(
      "po_dealer",
      "Purchase order → dealer",
      "ITARANG_TO_DEALER",
      dealerPo?.pdf_s3 ?? null,
      dealerPo?.number ?? null,
      dealerPo?.status ?? null,
    );
    add(
      "po_vendor",
      "Purchase order ← vendor",
      "VENDOR_TO_ITARANG",
      vendorPo?.pdf_s3 ?? null,
      vendorPo?.number ?? null,
      vendorPo?.status ?? null,
    );

    // --- Invoices ------------------------------------------------------------
    const invs = (await db.execute(sql`
      SELECT leg, raised_by_party, number, pdf_s3, status, returned_reason
      FROM invoices WHERE deal_id = ${header.deal_id}
      ORDER BY created_at
    `)) as unknown as Array<{
      leg: string;
      raised_by_party: string;
      number: string;
      pdf_s3: string | null;
      status: string;
      returned_reason: string | null;
    }>;

    const dealerInv = invs.find((i) => i.leg === "DEALER" && i.status !== "RETURNED");
    const vendorInv = invs.find((i) => i.leg === "VENDOR");

    add(
      "invoice_dealer",
      "Invoice ← dealer",
      "DEALER_TO_ITARANG",
      dealerInv?.pdf_s3 ?? null,
      dealerInv?.number ?? null,
      dealerInv?.status ?? null,
    );
    add(
      "invoice_vendor",
      "Invoice → vendor",
      "ITARANG_TO_VENDOR",
      vendorInv?.pdf_s3 ?? null,
      vendorInv?.number ?? null,
      vendorInv?.status ?? null,
    );

    // Returned invoices are kept deliberately — the history of what was rejected,
    // and why, is exactly what an auditor asks about.
    for (const r of invs.filter((i) => i.status === "RETURNED")) {
      add(
        "invoice_returned",
        `Invoice ${r.number} — returned: ${r.returned_reason ?? "no reason recorded"}`,
        "DEALER_TO_ITARANG",
        r.pdf_s3,
        r.number,
        "RETURNED",
      );
    }

    // --- Payment proofs ------------------------------------------------------
    const settlements = (await db.execute(sql`
      SELECT leg, leg_sub_id, method, proof_s3, statement_row_id
      FROM settlement_transactions WHERE deal_id = ${header.deal_id}
    `)) as unknown as Array<{
      leg: string;
      leg_sub_id: string;
      method: string;
      proof_s3: string | null;
      statement_row_id: string | null;
    }>;

    for (const leg of ["DEALER", "VENDOR"] as const) {
      const s = settlements.find((x) => x.leg === leg);
      // A STATEMENT settlement has no proof FILE — the bank statement is the proof.
      // Reporting it as "missing" would be a lie, so it is reported as what it is.
      const evidenced = s ? Boolean(s.proof_s3) || Boolean(s.statement_row_id) : false;

      docs.push({
        kind: leg === "DEALER" ? "proof_dealer" : "proof_vendor",
        label: leg === "DEALER" ? "Payment proof — dealer payout" : "Payment proof — vendor receipt",
        direction: leg === "DEALER" ? "ITARANG_TO_DEALER" : "VENDOR_TO_ITARANG",
        number: s?.leg_sub_id ?? null,
        status: s ? (s.proof_s3 ? "FILE" : "BANK STATEMENT") : null,
        s3_key: s?.proof_s3 ?? null,
        href: evidenceHref(s?.proof_s3 ?? null),
        present: evidenced,
      });
    }

    // --- BWM 2022 ------------------------------------------------------------
    const pickup = (await db.execute(sql`
      SELECT eway_bill_no, eway_bill_s3, weighbridge_slip_s3, variance_flag, dealer_ack_at
      FROM pickups WHERE deal_id = ${header.deal_id}
      ORDER BY created_at DESC LIMIT 1
    `)) as unknown as Array<Record<string, unknown>>;

    const p = pickup[0];
    add(
      "eway",
      "E-way bill (BWM 2022)",
      "DEALER_TO_ITARANG",
      (p?.eway_bill_s3 as string) ?? null,
      (p?.eway_bill_no as string) ?? null,
    );
    add(
      "weighbridge",
      "Weighbridge slip (BWM 2022)",
      "DEALER_TO_ITARANG",
      (p?.weighbridge_slip_s3 as string) ?? null,
    );

    // --- The AC ---------------------------------------------------------------
    const missing = REQUIRED_WHEN_CLOSED.filter(
      (kind) => !docs.some((d) => d.kind === kind && d.present),
    );

    return successResponse({
      request_id: request.id,
      request_no: request.request_no,
      status: header.status,
      documents: docs,
      // M15 AC: "every CLOSED deal has the full set." A closed deal missing a
      // document is not a cosmetic gap — it is a deal we cannot evidence.
      complete: missing.length === 0,
      missing,
      ac_breach: header.status === "CLOSED" && missing.length > 0,
    });
  },
);
