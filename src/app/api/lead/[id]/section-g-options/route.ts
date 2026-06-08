// Section G — Financing Options (Addendum V0.1 §5.2).
//
// Phase 3: BRE-driven match against the dealer's assigned active NBFC loan
// products, filtered by the lead's customer attributes (category, geography,
// resident status; loan amount when supplied via ?loanAmount=).
//
// Pre-amount call (no ?loanAmount=) skips the amount-band rule so the page
// can render indicative options before the dealer enters a final price.
// Section G submit re-fetches with ?loanAmount=N to filter to amount-eligible
// products only.
//
// Auth: dealer role + lead must belong to the dealer's org.

import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { dealers, leads, productCategories } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import {
  loadActiveProductsForDealer,
  matchProducts,
  type CustomerProfile,
} from "@/lib/bre";

const querySchema = z.object({
  loanAmount: z.coerce.number().min(0).optional(),
});

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireRole(["dealer"]);
    const { id: leadId } = await params;

    const { searchParams } = new URL(req.url);
    const parsed = querySchema.safeParse({
      loanAmount: searchParams.get("loanAmount") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { message: "Invalid query parameters" } },
        { status: 400 },
      );
    }
    const { loanAmount } = parsed.data;

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId)).limit(1);
    if (!lead) {
      return NextResponse.json(
        { success: false, error: { message: "Lead not found" } },
        { status: 404 },
      );
    }
    if (lead.dealer_id !== user.dealer_id) {
      return NextResponse.json(
        { success: false, error: { message: "Access denied" } },
        { status: 403 },
      );
    }
    if (!user.dealer_id) {
      return NextResponse.json({
        success: true,
        data: { items: [], engine: "bre-v1" },
      });
    }

    const [dealerRow] = await db
      .select({ id: dealers.id })
      .from(dealers)
      .where(eq(dealers.dealer_id, user.dealer_id))
      .limit(1);
    if (!dealerRow) {
      return NextResponse.json({
        success: true,
        data: { items: [], engine: "bre-v1" },
      });
    }

    const products = await loadActiveProductsForDealer(dealerRow.id);
    if (products.length === 0) {
      return NextResponse.json({
        success: true,
        data: { items: [], engine: "bre-v1" },
      });
    }

    // Resolve the lead's product_category_id (UUID FK) to its category name
    // (e.g. "3W", "2W") — that's what nbfc_loan_products.eligible_battery_categories
    // stores. The admin NBFC product form picks "3W"/"2W"/etc. so the matcher
    // must compare against the same string, not the lead's UUID.
    let batteryCategoryName: string | null = null;
    if (lead.product_category_id) {
      const [categoryRow] = await db
        .select({ name: productCategories.name })
        .from(productCategories)
        .where(eq(productCategories.id, lead.product_category_id))
        .limit(1);
      batteryCategoryName = categoryRow?.name ?? null;
    }

    const customer: CustomerProfile = {
      battery_category: batteryCategoryName,
      state: lead.state ?? null,
      city: lead.city ?? null,
      loan_amount: loanAmount ?? null,
      // Pre-bureau-check at this point in the flow; rule is skipped unless a
      // score is plumbed in by a later phase.
      credit_score: null,
      resident_status:
        lead.resident_status === "owned" || lead.resident_status === "rented"
          ? lead.resident_status
          : null,
    };

    const result = matchProducts(customer, products);

    const productIndex = new Map(products.map((p) => [p.id, p]));

    type NbfcGroup = {
      nbfcId: number;
      nbfcCode: string;
      shortName: string;
      legalName: string;
      activeLoanProducts: Array<{
        id: number;
        productName: string;
        loanAmountMin: number;
        loanAmountMax: number;
        tenureMonthsMin: number;
        tenureMonthsMax: number;
        minRoiPct: string;
        maxRoiPct: string;
        downPaymentPct: string;
      }>;
    };

    const byNbfc = new Map<number, NbfcGroup>();
    for (const hit of result.hits) {
      const meta = productIndex.get(hit.product_id);
      if (!meta) continue;
      const group = byNbfc.get(hit.nbfc_id) ?? {
        nbfcId: hit.nbfc_id,
        nbfcCode: meta.nbfc_id_code,
        shortName: meta.nbfc_short_name,
        legalName: meta.nbfc_legal_name,
        activeLoanProducts: [],
      };
      group.activeLoanProducts.push({
        id: hit.product_id,
        productName: hit.product_name,
        loanAmountMin: hit.bands.loan_amount_min,
        loanAmountMax: hit.bands.loan_amount_max,
        tenureMonthsMin: hit.bands.tenure_months_min,
        tenureMonthsMax: hit.bands.tenure_months_max,
        minRoiPct: hit.bands.min_roi_pct,
        maxRoiPct: hit.bands.max_roi_pct,
        downPaymentPct: hit.bands.down_payment_pct,
      });
      byNbfc.set(hit.nbfc_id, group);
    }

    return NextResponse.json({
      success: true,
      data: {
        items: Array.from(byNbfc.values()),
        engine: "bre-v1",
      },
    });
  } catch (err: unknown) {
    // postgres-js / Drizzle errors carry the underlying SQL in `.message`
    // (full SELECT statement). Leaking that into the UI is noisy + confusing.
    // Log the structured cause server-side so the failing column/relation is
    // recoverable from logs, but return a clean message to the client.
    const pg = extractPgError(err);
    if (pg) {
      console.error(
        "[section-g-options] postgres error",
        {
          code: pg.code,
          message: pg.message,
          detail: pg.detail,
          hint: pg.hint,
          table: pg.table,
          column: pg.column,
        },
      );
      const friendly = friendlyPgMessage(pg);
      return NextResponse.json(
        { success: false, error: { code: pg.code, message: friendly } },
        { status: 500 },
      );
    }
    const fallback = err instanceof Error ? err.message : "Failed to load NBFC options";
    console.error("[section-g-options] non-pg error", err);
    return NextResponse.json(
      { success: false, error: { message: fallback } },
      { status: 500 },
    );
  }
}

// Walk an error chain (Error.cause is the postgres-js error) and pull the
// Postgres-side metadata. Returns null if it doesn't look like a PG error.
type PgErrorShape = {
  code: string;
  message: string;
  detail?: string;
  hint?: string;
  table?: string;
  column?: string;
};

function extractPgError(err: unknown): PgErrorShape | null {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === "object" && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as Record<string, unknown>;
    const code = typeof e.code === "string" ? e.code : null;
    // PG SQLSTATE codes are 5 chars; postgres-js sets .code on the error.
    if (code && /^[0-9A-Z]{5}$/.test(code)) {
      return {
        code,
        message: typeof e.message === "string" ? e.message : "Database error",
        detail: typeof e.detail === "string" ? e.detail : undefined,
        hint: typeof e.hint === "string" ? e.hint : undefined,
        table: typeof e.table_name === "string"
          ? e.table_name
          : typeof e.table === "string" ? e.table : undefined,
        column: typeof e.column_name === "string"
          ? e.column_name
          : typeof e.column === "string" ? e.column : undefined,
      };
    }
    cur = (e.cause as unknown) ?? null;
  }
  return null;
}

function friendlyPgMessage(pg: PgErrorShape): string {
  switch (pg.code) {
    case "42P01":
      return `Database is missing the "${pg.table ?? "required"}" table. A migration is unapplied — run scripts/diagnose-section-g.mjs to identify which.`;
    case "42703":
      return `Database is missing the "${pg.column ?? "required"}" column on nbfc_loan_products. A migration (likely E-113 / E-114 / E-115) is unapplied — run scripts/diagnose-section-g.mjs.`;
    case "42501":
      return "Database permission denied. Check the DATABASE_URL role's grants.";
    case "57P03":
    case "08006":
    case "08003":
      return "Database connection failed. Check DATABASE_URL and that Postgres is reachable.";
    default:
      return `Database error (${pg.code}): ${pg.message}`;
  }
}
