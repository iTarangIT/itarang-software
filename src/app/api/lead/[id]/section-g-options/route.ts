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
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { loadSectionGOptions } from "@/lib/leads/section-g";

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

    // The match itself lives in @/lib/leads/section-g so the WhatsApp
    // lender-selection flow (E-264 Phase 2) asks the identical question
    // without a dealer session. It returns [] for "no dealer row" and
    // "no candidate products" alike — both mean the same thing to the page.
    // E-275 — when the query param is absent, fall back to the amount the
    // dealer answered to "Up to how much loan do you want?" so the list is
    // already filtered to lenders whose loan_amount_max covers the ask.
    const effectiveAmount = loanAmount ?? lead.requested_loan_amount ?? undefined;
    const items = await loadSectionGOptions(lead, effectiveAmount);

    return NextResponse.json({
      success: true,
      data: { items, engine: "bre-v1", loanAmount: effectiveAmount ?? null },
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
