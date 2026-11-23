/**
 * E-391 — Battery Pool diagram 1, part 2: NBFC routing rules (admin, sales_head).
 *
 * GET              → active + inactive rules, product categories, NBFC/product options.
 * GET ?leadId=     → test a lead: which rule fits and whether the BRE accepts it (read-only).
 * POST             → create a rule { dealer_code?, state?, city?, product_category?, nbfc_id, loan_product_id, notes? }.
 * DELETE ?id=      → deactivate a rule.
 *
 * When Step 4 opens and the most specific active rule fits, the file goes to
 * that NBFC automatically (src/lib/leads/nbfc-routing.ts).
 */
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { accounts, nbfc, nbfcLoanProducts, nbfcRoutingRules, productCategories, users } from "@/lib/db/schema";
import { describeRuleScope, resolveRoutingTarget, ruleWeight, validateRuleScope } from "@/lib/leads/nbfc-routing";

export const dynamic = "force-dynamic";

const EDITOR_ROLES = ["admin", "sales_head"];

const blank = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole(EDITOR_ROLES);
  const leadId = new URL(req.url).searchParams.get("leadId");
  if (leadId) {
    const t = await resolveRoutingTarget(leadId.trim());
    return successResponse({
      test: t.ok
        ? { ok: true, ruleId: t.rule?.id ?? null, source: t.source, scope: t.scope, nbfcName: t.nbfcName, productName: t.productName }
        : { ok: false, why: t.why, ruleId: t.rule?.id ?? null },
    });
  }

  const rules = await db
    .select({
      id: nbfcRoutingRules.id,
      dealer_code: nbfcRoutingRules.dealer_code,
      state: nbfcRoutingRules.state,
      city: nbfcRoutingRules.city,
      product_category: nbfcRoutingRules.product_category,
      nbfc_id: nbfcRoutingRules.nbfc_id,
      loan_product_id: nbfcRoutingRules.loan_product_id,
      is_active: nbfcRoutingRules.is_active,
      notes: nbfcRoutingRules.notes,
      created_at: nbfcRoutingRules.created_at,
      updated_at: nbfcRoutingRules.updated_at,
      dealerName: accounts.business_entity_name,
      nbfcName: nbfc.short_name,
      productName: nbfcLoanProducts.product_name,
      createdBy: users.name,
    })
    .from(nbfcRoutingRules)
    .leftJoin(accounts, eq(accounts.id, nbfcRoutingRules.dealer_code))
    .leftJoin(nbfc, eq(nbfc.id, nbfcRoutingRules.nbfc_id))
    .leftJoin(nbfcLoanProducts, eq(nbfcLoanProducts.id, nbfcRoutingRules.loan_product_id))
    .leftJoin(users, eq(users.id, nbfcRoutingRules.created_by))
    .orderBy(desc(nbfcRoutingRules.is_active), desc(nbfcRoutingRules.id));

  const categories = await db
    .select({ id: productCategories.id, name: productCategories.name })
    .from(productCategories)
    .orderBy(asc(productCategories.name));

  const productRows = await db
    .select({
      nbfcId: nbfc.id,
      nbfcShortName: nbfc.short_name,
      productId: nbfcLoanProducts.id,
      productName: nbfcLoanProducts.product_name,
      loanAmountMax: nbfcLoanProducts.loan_amount_max,
    })
    .from(nbfcLoanProducts)
    .innerJoin(nbfc, eq(nbfc.id, nbfcLoanProducts.nbfc_id))
    .where(and(eq(nbfcLoanProducts.status, "active"), isNotNull(nbfc.tenant_id)))
    .orderBy(asc(nbfc.short_name), asc(nbfcLoanProducts.product_name));
  const byNbfc = new Map<number, { id: number; name: string; products: Array<{ id: number; name: string; loanAmountMax: number }> }>();
  for (const r of productRows) {
    const e = byNbfc.get(r.nbfcId) ?? { id: r.nbfcId, name: r.nbfcShortName, products: [] };
    e.products.push({ id: r.productId, name: r.productName, loanAmountMax: r.loanAmountMax });
    byNbfc.set(r.nbfcId, e);
  }

  return successResponse({
    rules: rules.map((r) => ({
      ...r,
      scope: describeRuleScope(r, r.dealerName),
      weight: ruleWeight(r),
    })),
    categories: [...new Set(categories.map((c) => c.name).filter(Boolean))],
    nbfcs: Array.from(byNbfc.values()),
  });
});

const Body = z.object({
  dealer_code: z.string().trim().max(255).optional().nullable(),
  state: z.string().trim().max(100).optional().nullable(),
  city: z.string().trim().max(100).optional().nullable(),
  product_category: z.string().trim().max(50).optional().nullable(),
  nbfc_id: z.number().int().positive(),
  loan_product_id: z.number().int().positive(),
  notes: z.string().trim().max(500).optional().nullable(),
});

export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole(EDITOR_ROLES);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse(parsed.error.issues[0]?.message ?? "Check the rule", 400);
  const d = parsed.data;
  const scope = {
    dealer_code: blank(d.dealer_code),
    state: blank(d.state),
    city: blank(d.city),
    product_category: blank(d.product_category),
  };
  const v = validateRuleScope(scope);
  if (!v.ok) return errorResponse(v.message, 400);

  const [prod] = await db
    .select({ id: nbfcLoanProducts.id })
    .from(nbfcLoanProducts)
    .innerJoin(nbfc, eq(nbfc.id, nbfcLoanProducts.nbfc_id))
    .where(
      and(
        eq(nbfcLoanProducts.id, d.loan_product_id),
        eq(nbfcLoanProducts.nbfc_id, d.nbfc_id),
        eq(nbfcLoanProducts.status, "active"),
        isNotNull(nbfc.tenant_id),
      ),
    )
    .limit(1);
  if (!prod) return errorResponse("Pick an active loan product of that NBFC.", 400);

  if (scope.dealer_code) {
    const [acc] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, scope.dealer_code)).limit(1);
    if (!acc) return errorResponse("That dealer was not found.", 400);
  }

  const lc = (col: unknown, v: string | null) => sql`lower(coalesce(${col}, '')) = ${(v ?? "").toLowerCase()}`;
  const [dup] = await db
    .select({ id: nbfcRoutingRules.id })
    .from(nbfcRoutingRules)
    .where(
      and(
        eq(nbfcRoutingRules.is_active, true),
        lc(nbfcRoutingRules.dealer_code, scope.dealer_code),
        lc(nbfcRoutingRules.state, scope.state),
        lc(nbfcRoutingRules.city, scope.city),
        lc(nbfcRoutingRules.product_category, scope.product_category),
      ),
    )
    .limit(1);
  if (dup) return errorResponse(`Rule #${dup.id} already covers this scope — deactivate it first.`, 409);

  const now = new Date();
  const [row] = await db
    .insert(nbfcRoutingRules)
    .values({
      ...scope,
      nbfc_id: d.nbfc_id,
      loan_product_id: d.loan_product_id,
      is_active: true,
      notes: blank(d.notes),
      created_by: user.id,
      updated_by: user.id,
      created_at: now,
      updated_at: now,
    })
    .returning({ id: nbfcRoutingRules.id });
  return successResponse({ id: row.id });
});

export const DELETE = withErrorHandler(async (req: Request) => {
  const user = await requireRole(EDITOR_ROLES);
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) return errorResponse("Rule id required", 400);
  const rows = await db
    .update(nbfcRoutingRules)
    .set({ is_active: false, updated_by: user.id, updated_at: new Date() })
    .where(and(eq(nbfcRoutingRules.id, id), inArray(nbfcRoutingRules.is_active, [true])))
    .returning({ id: nbfcRoutingRules.id });
  if (!rows.length) return errorResponse("Rule not found or already inactive", 404);
  return successResponse({ id });
});
