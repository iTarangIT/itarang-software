/**
 * E-282/E-283/E-286 — Settings → Loan Product: the default NBFC + loan product
 * pinned to a dealer, to a DEALER LOCATION, or both. Since E-286 `state` and
 * `city` describe the dealer's own registered address (accounts.state /
 * accounts.city), not the customer's — see city-default-product.ts.
 *
 * Kept out of the `/api/admin/settings` bundle for the same reason
 * `/api/admin/settings/nbfc-request-sla` is: it is its own concern, not part of
 * the assignment / holiday / territory triple. Unlike its siblings this is a
 * ROW STORE rather than an `app_settings` blob — there is one row per rule,
 * which a jsonb singleton would turn into a read-modify-write race.
 *
 * GET    → the current rules plus the NBFC/product options the form needs.
 * GET ?dealerCode= → the NBFC ids blocked for that dealer, for the form warning.
 * POST   → create or replace the rule for a (dealer, state, city). `cities` may
 *          name several at once; each becomes its own row, because that is what
 *          resolveDefaultProductRules() and the partial unique index key on.
 * DELETE → deactivate one rule by id.
 */

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
  errorResponse,
  successResponse,
  withErrorHandler,
} from "@/lib/api-utils";
import {
  accounts,
  cityDefaultLoanProducts,
  dealerNbfcAssignments,
  dealers,
  nbfc,
  nbfcLoanProducts,
} from "@/lib/db/schema";

export const dynamic = "force-dynamic";

const EDITOR_ROLES = ["admin", "sales_head"];

/** Mirrors BLOCKING_STATUSES in src/lib/bre/load-products.ts. */
const BLOCKING_STATUSES = ["suspended", "terminated"];

const BodySchema = z.object({
  // Omitted / null / "" = the rule applies to every dealer.
  dealer_code: z.string().trim().max(255).optional().nullable(),
  // E-283 made this optional: omitted = the rule declares no location, which is
  // only meaningful together with a dealer_code (enforced below).
  state: z.string().trim().max(100).optional().nullable(),
  // Omitted / null / "" = every dealer city in the state.
  city: z.string().trim().max(100).optional().nullable(),
  // Several cities pinned to the same lender + product in one go; each is
  // saved as its own rule. Kept alongside `city` so a caller may send either.
  // Capped so a mis-click cannot write hundreds of rules in one request.
  cities: z.array(z.string().trim().max(100)).max(200).optional().nullable(),
  nbfc_id: z.number().int().positive(),
  loan_product_id: z.number().int().positive(),
  // Highest wins; specificity breaks ties. Bounded so a typo cannot create a
  // rule that can never be outranked.
  priority: z.number().int().min(0).max(1000).optional(),
  notes: z.string().trim().max(500).optional().nullable(),
});

/**
 * The NBFC ids `loadActiveProductsForDealer` would drop for this dealer, so the
 * form can warn that a pin could never fire. Resolves the dealer CODE to the
 * serial `dealers.id` that `dealer_nbfc_assignments` keys on — the two are
 * different identifiers and mixing them silently returns nothing.
 */
async function blockedNbfcIdsForDealer(dealerCode: string): Promise<number[]> {
  const [dealerRow] = await db
    .select({ id: dealers.id })
    .from(dealers)
    .where(eq(dealers.dealer_id, dealerCode))
    .limit(1);
  if (!dealerRow) return [];

  const rows = await db
    .select({ nbfc_id: dealerNbfcAssignments.nbfc_id })
    .from(dealerNbfcAssignments)
    .where(
      and(
        eq(dealerNbfcAssignments.dealer_id, dealerRow.id),
        inArray(dealerNbfcAssignments.status, BLOCKING_STATUSES),
      ),
    );
  return rows.map((r) => r.nbfc_id);
}

export const GET = withErrorHandler(async (req: Request) => {
  await requireRole(EDITOR_ROLES);

  // Sub-request from the form when a dealer is picked: just the blocked set.
  const dealerCode = new URL(req.url).searchParams.get("dealerCode");
  if (dealerCode) {
    return successResponse({
      blockedNbfcIds: await blockedNbfcIdsForDealer(dealerCode.trim()),
    });
  }

  const rows = await db
    .select({
      id: cityDefaultLoanProducts.id,
      dealerCode: cityDefaultLoanProducts.dealer_code,
      state: cityDefaultLoanProducts.state,
      city: cityDefaultLoanProducts.city,
      priority: cityDefaultLoanProducts.priority,
      nbfcId: cityDefaultLoanProducts.nbfc_id,
      loanProductId: cityDefaultLoanProducts.loan_product_id,
      notes: cityDefaultLoanProducts.notes,
      updatedAt: cityDefaultLoanProducts.updated_at,
      dealerName: accounts.business_entity_name,
      nbfcShortName: nbfc.short_name,
      nbfcCode: nbfc.nbfc_id,
      productName: nbfcLoanProducts.product_name,
      productStatus: nbfcLoanProducts.status,
    })
    .from(cityDefaultLoanProducts)
    .leftJoin(accounts, eq(accounts.id, cityDefaultLoanProducts.dealer_code))
    .leftJoin(nbfc, eq(nbfc.id, cityDefaultLoanProducts.nbfc_id))
    .leftJoin(
      nbfcLoanProducts,
      eq(nbfcLoanProducts.id, cityDefaultLoanProducts.loan_product_id),
    )
    .where(eq(cityDefaultLoanProducts.is_active, true))
    // The SAME order resolveDefaultProductRules() applies, so the admin reads
    // the table top-down as the resolution order rather than inferring it.
    .orderBy(
      desc(cityDefaultLoanProducts.priority),
      sql`(${cityDefaultLoanProducts.dealer_code} IS NULL)`,
      sql`(${cityDefaultLoanProducts.city} IS NULL)`,
      sql`(${cityDefaultLoanProducts.state} IS NULL)`,
      desc(cityDefaultLoanProducts.id),
    );

  // Only products the router could actually reach: active, and bound to a
  // portal tenant. Same two guards `loadActiveProductsForDealer` applies — an
  // unbound NBFC never receives the lead, so pinning one would create a
  // default that silently never fires.
  const productRows = await db
    .select({
      nbfcId: nbfc.id,
      nbfcShortName: nbfc.short_name,
      nbfcLegalName: nbfc.legal_name,
      nbfcCode: nbfc.nbfc_id,
      productId: nbfcLoanProducts.id,
      productName: nbfcLoanProducts.product_name,
      loanAmountMin: nbfcLoanProducts.loan_amount_min,
      loanAmountMax: nbfcLoanProducts.loan_amount_max,
    })
    .from(nbfcLoanProducts)
    .innerJoin(nbfc, eq(nbfc.id, nbfcLoanProducts.nbfc_id))
    .where(
      and(eq(nbfcLoanProducts.status, "active"), isNotNull(nbfc.tenant_id)),
    )
    .orderBy(asc(nbfc.short_name), asc(nbfcLoanProducts.product_name));

  const byNbfc = new Map<
    number,
    {
      id: number;
      shortName: string;
      legalName: string;
      code: string;
      products: {
        id: number;
        productName: string;
        loanAmountMin: number;
        loanAmountMax: number;
      }[];
    }
  >();
  for (const r of productRows) {
    const entry = byNbfc.get(r.nbfcId) ?? {
      id: r.nbfcId,
      shortName: r.nbfcShortName,
      legalName: r.nbfcLegalName,
      code: r.nbfcCode,
      products: [],
    };
    entry.products.push({
      id: r.productId,
      productName: r.productName,
      loanAmountMin: r.loanAmountMin,
      loanAmountMax: r.loanAmountMax,
    });
    byNbfc.set(r.nbfcId, entry);
  }

  return successResponse({ rows, nbfcs: Array.from(byNbfc.values()) });
});

export const POST = withErrorHandler(async (req: Request) => {
  const actor = await requireRole(EDITOR_ROLES);
  const b = BodySchema.parse(await req.json());

  const dealerCode =
    b.dealer_code && b.dealer_code.length > 0 ? b.dealer_code : null;
  const state = b.state && b.state.length > 0 ? b.state : null;
  const priority = b.priority ?? 0;

  // `city` and `cities` fold into one list. Blank entries drop out, and
  // duplicates are collapsed case-insensitively so two spellings of the same
  // city cannot trip the partial unique index against each other mid-loop.
  const seen = new Set<string>();
  const cityList: string[] = [];
  for (const raw of [...(b.cities ?? []), b.city ?? ""]) {
    const value = (raw ?? "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cityList.push(value);
  }
  // No city named at all = one state-wide (or dealer-only) rule.
  const targets: (string | null)[] = cityList.length > 0 ? cityList : [null];

  // A rule with no dealer AND no state matches every finance lead in the
  // country. That is almost certainly a misconfiguration rather than an intent,
  // and it would shadow every other rule sharing its priority.
  //
  // The state/city named here are the DEALER's, and they are NOT validated
  // against the dealer directory: a dealer can move, and a rule written ahead
  // of a dealer's onboarding is legitimate. The admin form warns when a named
  // dealer is not in the named location, which is the only combination that
  // can never match.
  if (!dealerCode && !state) {
    return errorResponse(
      "A default must name a dealer, a location, or both.",
      400,
    );
  }

  // A city without a state cannot be matched — the resolver keys on both.
  if (cityList.length > 0 && !state) {
    return errorResponse("Select a state before choosing a city.", 400);
  }

  // The dealer must really exist. `dealer_code` is a loose ref (like nbfc_id
  // and loan_product_id already are on this table), so this is the only thing
  // standing between a typo and a rule that can never fire.
  if (dealerCode) {
    const [dealer] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, dealerCode))
      .limit(1);
    if (!dealer) {
      return errorResponse(
        `No dealer found with the code "${dealerCode}".`,
        400,
      );
    }
  }

  // The product must really belong to the chosen NBFC, be active, and be
  // routable. Without this an admin could pin a product from lender A under
  // lender B and the default would never match anything.
  const [product] = await db
    .select({ id: nbfcLoanProducts.id })
    .from(nbfcLoanProducts)
    .innerJoin(nbfc, eq(nbfc.id, nbfcLoanProducts.nbfc_id))
    .where(
      and(
        eq(nbfcLoanProducts.id, b.loan_product_id),
        eq(nbfcLoanProducts.nbfc_id, b.nbfc_id),
        eq(nbfcLoanProducts.status, "active"),
        isNotNull(nbfc.tenant_id),
      ),
    )
    .limit(1);
  if (!product) {
    return errorResponse(
      "That loan product does not belong to the selected NBFC, is not active, or the NBFC is not bound to a portal tenant.",
      400,
    );
  }

  // Replace rather than collide: the partial unique index allows exactly one
  // ACTIVE row per (dealer_code, state, city), and deactivating keeps the old
  // row as history — the same pattern dealer_salespersons uses. The predicate
  // must match that key exactly, NULLs included, or the insert trips it.
  //
  // One city per row, so a multi-city selection is a loop — inside a single
  // transaction, so a failure part-way through leaves none of the cities
  // half-applied against the ones they replaced.
  await db.transaction(async (tx) => {
    for (const city of targets) {
      await tx
        .update(cityDefaultLoanProducts)
        .set({
          is_active: false,
          updated_by: actor.id,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(cityDefaultLoanProducts.is_active, true),
            dealerCode === null
              ? sql`${cityDefaultLoanProducts.dealer_code} IS NULL`
              : sql`lower(btrim(${cityDefaultLoanProducts.dealer_code})) = ${dealerCode.toLowerCase()}`,
            state === null
              ? sql`${cityDefaultLoanProducts.state} IS NULL`
              : sql`lower(btrim(${cityDefaultLoanProducts.state})) = ${state.toLowerCase()}`,
            city === null
              ? sql`${cityDefaultLoanProducts.city} IS NULL`
              : sql`lower(btrim(${cityDefaultLoanProducts.city})) = ${city.toLowerCase()}`,
          ),
        );

      await tx.insert(cityDefaultLoanProducts).values({
        dealer_code: dealerCode,
        state,
        city,
        priority,
        nbfc_id: b.nbfc_id,
        loan_product_id: b.loan_product_id,
        notes: b.notes ?? null,
        created_by: actor.id,
        updated_by: actor.id,
      });
    }
  });

  return successResponse({ ok: true, created: targets.length });
});

export const DELETE = withErrorHandler(async (req: Request) => {
  const actor = await requireRole(EDITOR_ROLES);
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return errorResponse("A numeric ?id is required.", 400);
  }

  await db
    .update(cityDefaultLoanProducts)
    .set({ is_active: false, updated_by: actor.id, updated_at: new Date() })
    .where(eq(cityDefaultLoanProducts.id, id));

  return successResponse({ ok: true });
});
