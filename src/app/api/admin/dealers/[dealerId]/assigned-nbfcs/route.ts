// [E-013] /api/admin/dealers/{dealerId}/assigned-nbfcs  (GET)
//
// BRD §6.0.8 — Loan-sanction dropdown source. Lists the NBFCs that a given
// dealer is assigned to (via dealer_nbfc_assignments), filtered by assignment
// status (default 'active'). For each NBFC, returns only the loan products
// with status='active'.
//
// Sync Audit G-05: This endpoint is the SOLE source of truth for the loan
// sanction dropdown — admin UI must not bypass it. Prevents an admin from
// entering a lender that has no agreement with this dealer.
//
// Rules:
//   - Dealer missing -> 404.
//   - ?status= one of {active,suspended,terminated}; default 'active'.
//   - Empty items array when the dealer has no assignment rows for the filter.
//   - activeLoanProducts only contains nbfc_loan_products where status='active'.
//   - Auth: admin (requireAdminOrTestBypass for the loop test plumbing).
//
// dealerId path param is dual-keyed (mirrors E-012/E-102): pure-numeric => INT
// PK lookup, anything else => VARCHAR dealer_id lookup.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dealers,
  dealerNbfcAssignments,
  nbfc,
  nbfcLoanProducts,
} from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";

type RouteContext = {
  params: Promise<{ dealerId: string }>;
};

const getQuerySchema = z.object({
  status: z.enum(["active", "suspended", "terminated"]).default("active"),
});

function isNumericId(value: string): boolean {
  return /^\d+$/.test(value);
}

async function resolveDealer(dealerIdParam: string) {
  const [row] = isNumericId(dealerIdParam)
    ? await db
        .select()
        .from(dealers)
        .where(eq(dealers.id, Number(dealerIdParam)))
        .limit(1)
    : await db
        .select()
        .from(dealers)
        .where(eq(dealers.dealer_id, dealerIdParam))
        .limit(1);
  return row ?? null;
}

export async function GET(req: NextRequest, context: RouteContext) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  try {
    const { dealerId: dealerIdParam } = await context.params;
    if (!dealerIdParam) {
      return NextResponse.json(
        { success: false, message: "Missing dealerId path parameter" },
        { status: 400 },
      );
    }

    const url = new URL(req.url);
    const parsedQuery = getQuerySchema.safeParse({
      status: url.searchParams.get("status") ?? undefined,
    });
    if (!parsedQuery.success) {
      return NextResponse.json(
        {
          success: false,
          error: "VALIDATION_ERROR",
          message: "Invalid query parameters",
          issues: parsedQuery.error.flatten(),
        },
        { status: 400 },
      );
    }
    const statusFilter = parsedQuery.data.status;

    const dealerRow = await resolveDealer(dealerIdParam);
    if (!dealerRow) {
      return NextResponse.json(
        { success: false, error: "DEALER_NOT_FOUND", message: "Dealer not found" },
        { status: 404 },
      );
    }

    // Step 1: assignments JOIN nbfc, filtered by assignment status.
    const assignmentRows = await db
      .select({
        nbfcId: nbfc.id,
        shortName: nbfc.short_name,
        legalName: nbfc.legal_name,
      })
      .from(dealerNbfcAssignments)
      .innerJoin(nbfc, eq(dealerNbfcAssignments.nbfc_id, nbfc.id))
      .where(
        and(
          eq(dealerNbfcAssignments.dealer_id, dealerRow.id),
          eq(dealerNbfcAssignments.status, statusFilter),
        ),
      );

    if (assignmentRows.length === 0) {
      return NextResponse.json({ success: true, items: [] });
    }

    // Step 2: fetch all active loan products for the assigned NBFCs in one go.
    const nbfcIds = assignmentRows.map((r) => r.nbfcId);
    const productRows = await db
      .select({
        id: nbfcLoanProducts.id,
        nbfcId: nbfcLoanProducts.nbfc_id,
        productName: nbfcLoanProducts.product_name,
        loanAmountMin: nbfcLoanProducts.loan_amount_min,
        loanAmountMax: nbfcLoanProducts.loan_amount_max,
      })
      .from(nbfcLoanProducts)
      .where(
        and(
          inArray(nbfcLoanProducts.nbfc_id, nbfcIds),
          eq(nbfcLoanProducts.status, "active"),
        ),
      );

    const productsByNbfc = new Map<
      number,
      Array<{
        id: number;
        productName: string;
        loanAmountMin: number;
        loanAmountMax: number;
      }>
    >();
    for (const p of productRows) {
      const list = productsByNbfc.get(p.nbfcId) ?? [];
      list.push({
        id: p.id,
        productName: p.productName,
        loanAmountMin: p.loanAmountMin,
        loanAmountMax: p.loanAmountMax,
      });
      productsByNbfc.set(p.nbfcId, list);
    }

    const items = assignmentRows.map((r) => ({
      nbfcId: r.nbfcId,
      shortName: r.shortName,
      legalName: r.legalName,
      activeLoanProducts: productsByNbfc.get(r.nbfcId) ?? [],
    }));

    return NextResponse.json({ success: true, items });
  } catch (error: unknown) {
    console.error("ADMIN DEALER ASSIGNED-NBFCS GET ERROR:", error);
    return NextResponse.json(
      { success: false, message: "Failed to fetch assigned NBFCs" },
      { status: 500 },
    );
  }
}
