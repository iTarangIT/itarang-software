import { db } from "@/lib/db";
import { accounts, inventory } from "@/lib/db/schema";
import { and, eq, ilike, ne, or, sql, type SQL } from "drizzle-orm";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireInventoryAdmin } from "@/lib/auth-utils";

// BRD V2 §5.0.2.2 — list dealers for the inventory upload wizard, the
// transfer page, the ageing report filters, the inventory dashboard, and the
// coupon-create page. Six call sites all expect the same shape.
//
//   GET /api/admin/dealers
//     ?search=query    case-insensitive match on name / dealer_code / city
//     ?status=…        explicit accounts.status filter (active|inactive|all);
//                      omitted = "all onboarded dealers except rejected ones",
//                      which is what every inventory dropdown actually wants
//     ?limit=500       caller-controlled cap, default 200, max 1000
//     ?includeStock=1  attach { batteries, chargers, paraphernalia }
//                      counts to each dealer (one extra grouped query)
//
// Visibility line is onboarding_status, not status. A dealer mid-KYC-correction
// has accounts.status='inactive' but is still operational on the dealer portal
// and must appear in admin inventory tooling. Only onboarding_status='rejected'
// is a true exclusion.

export const GET = withErrorHandler(async (req: Request) => {
  await requireInventoryAdmin();

  const { searchParams } = new URL(req.url);
  const search = searchParams.get("search")?.trim() ?? "";
  const statusParam = searchParams.get("status")?.trim() ?? "";
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 200), 1), 1000);
  const includeStock =
    searchParams.get("includeStock") === "1" ||
    searchParams.get("include_stock") === "1";

  const conditions: SQL[] = [];
  if (statusParam && statusParam !== "all") {
    conditions.push(eq(accounts.status, statusParam));
  } else {
    conditions.push(ne(accounts.onboarding_status, "rejected"));
  }
  if (search) {
    const like = `%${search}%`;
    const expr = or(
      ilike(accounts.business_entity_name, like),
      ilike(accounts.dealer_code, like),
      ilike(accounts.city, like),
      ilike(accounts.state, like),
    );
    if (expr) conditions.push(expr);
  }

  const rows = await db
    .select({
      id: accounts.id,
      business_entity_name: accounts.business_entity_name,
      dealer_code: accounts.dealer_code,
      city: accounts.city,
      state: accounts.state,
      contact_name: accounts.contact_name,
      contact_phone: accounts.contact_phone,
      address_line1: accounts.address_line1,
      pincode: accounts.pincode,
      onboarding_status: accounts.onboarding_status,
      status: accounts.status,
      created_at: accounts.created_at,
    })
    .from(accounts)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(accounts.business_entity_name)
    .limit(limit);

  // Optional dealer-level stock counts. Single grouped query so we don't N+1.
  let stockByDealer = new Map<
    string,
    { batteries: number; chargers: number; paraphernalia: number; available: number }
  >();
  if (includeStock && rows.length > 0) {
    const dealerIds = rows.map((r) => r.id);
    try {
      const counts = await db
        .select({
          dealer_id: inventory.dealer_id,
          asset_category: inventory.asset_category,
          status: inventory.status,
          n: sql<number>`count(*)::int`,
        })
        .from(inventory)
        .where(
          and(
            sql`${inventory.dealer_id} = ANY(ARRAY[${sql.join(
              dealerIds.map((d) => sql`${d}`),
              sql`, `,
            )}]::varchar[])`,
            sql`${inventory.status} NOT IN ('sold','written_off')`,
          ),
        )
        .groupBy(inventory.dealer_id, inventory.asset_category, inventory.status);

      stockByDealer = new Map();
      for (const c of counts) {
        if (!c.dealer_id) continue;
        const bucket = stockByDealer.get(c.dealer_id) ?? {
          batteries: 0,
          chargers: 0,
          paraphernalia: 0,
          available: 0,
        };
        const cat = (c.asset_category || "").toLowerCase();
        if (cat.includes("battery")) bucket.batteries += c.n;
        else if (cat.includes("charger")) bucket.chargers += c.n;
        else if (cat.includes("paraphernalia")) bucket.paraphernalia += c.n;
        if (c.status === "available") bucket.available += c.n;
        stockByDealer.set(c.dealer_id, bucket);
      }
    } catch (err) {
      // Stock totals are a nice-to-have. Falling back to zeros keeps the
      // dropdown working even if the inventory table is mid-migration.
      console.warn(
        "[/api/admin/dealers] inventory counts failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  const data = rows.map((r) => ({
    id: r.id,
    business_entity_name: r.business_entity_name,
    dealer_code: r.dealer_code,
    city: r.city,
    state: r.state,
    contact_name: r.contact_name,
    contact_phone: r.contact_phone,
    address_line1: r.address_line1,
    pincode: r.pincode,
    onboarding_status: r.onboarding_status,
    status: r.status,
    created_at: r.created_at,
    ...(includeStock
      ? {
          currentStock: stockByDealer.get(r.id) ?? {
            batteries: 0,
            chargers: 0,
            paraphernalia: 0,
            available: 0,
          },
        }
      : {}),
  }));

  return successResponse(data);
});
