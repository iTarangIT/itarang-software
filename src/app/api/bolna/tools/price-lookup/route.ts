import { db } from "@/lib/db";
import { products, productCategories } from "@/lib/db/schema";
import { eq, and, ilike, or, sql } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";

/**
 * Bolna Tool Endpoint — Price Lookup
 *
 * Bolna calls this mid-conversation when the dealer asks about price.
 * Handles:
 *   1. Single product price lookup ("51V 105AH ka price batao")
 *   2. Compare two products ("51V 105AH aur 61V 132AH me difference batao")
 *   3. List all products in a category / asset type
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    console.log("[BOLNA TOOL] price-lookup hit:", JSON.stringify(body));

    // Bolna sends tool args — extract the query/product names
    const query: string = body.product_name || body.query || "";
    const product1: string = body.product_1 || "";
    const product2: string = body.product_2 || "";

    // ── Compare mode: two products ──
    if (product1 && product2) {
      const [p1, p2] = await Promise.all([
        findProduct(product1),
        findProduct(product2),
      ]);

      if (!p1 && !p2) {
        return NextResponse.json({
          status: "not_found",
          message: "Dono products nahi mile. Kya aap sahi naam bata sakte hain?",
        });
      }
      if (!p1) {
        return NextResponse.json({
          status: "partial",
          message: `${product1} nahi mila, lekin ${product2} ka price ₹${p2!.price} hai.`,
          products: [formatProduct(p2!)],
        });
      }
      if (!p2) {
        return NextResponse.json({
          status: "partial",
          message: `${product2} nahi mila, lekin ${product1} ka price ₹${p1.price} hai.`,
          products: [formatProduct(p1)],
        });
      }

      const diff = Math.abs((p1.price ?? 0) - (p2.price ?? 0));
      const cheaper = (p1.price ?? 0) <= (p2.price ?? 0) ? p1 : p2;
      const costlier = (p1.price ?? 0) > (p2.price ?? 0) ? p1 : p2;

      return NextResponse.json({
        status: "comparison",
        message:
          `${p1.name} ka price ₹${p1.price} hai aur ${p2.name} ka price ₹${p2.price} hai. ` +
          `Dono me ₹${diff} ka difference hai. ${cheaper.name} sasta hai aur ${costlier.name} mehenga hai.`,
        product_1: formatProduct(p1),
        product_2: formatProduct(p2),
        price_difference: diff,
      });
    }

    // ── Single product lookup ──
    if (query) {
      const found = await findProduct(query);

      if (!found) {
        // Try listing all matching products
        const matches = await searchProducts(query);
        if (matches.length > 0) {
          const list = matches
            .map((p) => `${p.name} — ₹${p.price}`)
            .join(", ");
          return NextResponse.json({
            status: "multiple",
            message: `Humne ye products dhundhe: ${list}. Kaun sa chahiye aapko?`,
            products: matches.map(formatProduct),
          });
        }

        return NextResponse.json({
          status: "not_found",
          message: "Ye product nahi mila. Kya aap voltage ya model bata sakte hain?",
        });
      }

      return NextResponse.json({
        status: "found",
        message: `${found.name} ka price ₹${found.price} hai.${found.warranty_months ? ` Isme ${found.warranty_months} mahine ki warranty milti hai.` : ""}`,
        product: formatProduct(found),
      });
    }

    // ── No query — list all active products ──
    const allProducts = await db
      .select()
      .from(products)
      .where(and(eq(products.is_active, true), eq(products.status, "active")))
      .orderBy(products.sort_order);

    const list = allProducts
      .map((p) => `${p.name} — ₹${p.price}`)
      .join(", ");

    return NextResponse.json({
      status: "list",
      message: `Humare paas ye products available hain: ${list}`,
      products: allProducts.map(formatProduct),
    });
  } catch (err: any) {
    console.error("[BOLNA TOOL] price-lookup error:", err);
    return NextResponse.json(
      { status: "error", message: "Price check me error aa gaya, thodi der baad try karein." },
      { status: 500 },
    );
  }
}

// ── Find a single product by name, voltage+capacity, or SKU ──
async function findProduct(query: string) {
  const q = query.trim();

  // Try exact/close name match
  const [byName] = await db
    .select()
    .from(products)
    .where(and(ilike(products.name, `%${q}%`), eq(products.is_active, true)))
    .limit(1);

  if (byName) return byName;

  // Try by SKU
  const [bySku] = await db
    .select()
    .from(products)
    .where(and(ilike(products.sku, `%${q}%`), eq(products.is_active, true)))
    .limit(1);

  if (bySku) return bySku;

  // Try parsing voltage/capacity from query like "51V 105AH" or "51 105"
  const voltCapMatch = q.match(/(\d+)\s*[vV]?\s*(\d+)\s*[aA][hH]?/);
  if (voltCapMatch) {
    const voltage = parseInt(voltCapMatch[1]);
    const capacity = parseInt(voltCapMatch[2]);

    const [bySpec] = await db
      .select()
      .from(products)
      .where(
        and(
          eq(products.voltage_v, voltage),
          eq(products.capacity_ah, capacity),
          eq(products.is_active, true),
        ),
      )
      .limit(1);

    if (bySpec) return bySpec;
  }

  // Try just voltage match
  const voltMatch = q.match(/(\d+)\s*[vV]/);
  if (voltMatch) {
    const voltage = parseInt(voltMatch[1]);
    const [byVolt] = await db
      .select()
      .from(products)
      .where(
        and(eq(products.voltage_v, voltage), eq(products.is_active, true)),
      )
      .limit(1);

    if (byVolt) return byVolt;
  }

  return null;
}

// ── Search products by keyword ──
async function searchProducts(query: string) {
  const q = query.trim();

  return db
    .select()
    .from(products)
    .where(
      and(
        eq(products.is_active, true),
        or(
          ilike(products.name, `%${q}%`),
          ilike(products.sku, `%${q}%`),
          ilike(products.asset_type, `%${q}%`),
        ),
      ),
    )
    .orderBy(products.sort_order)
    .limit(10);
}

// ── Format product for response ──
function formatProduct(p: any) {
  return {
    name: p.name,
    sku: p.sku,
    price: p.price,
    voltage: p.voltage_v,
    capacity_ah: p.capacity_ah,
    asset_type: p.asset_type,
    warranty_months: p.warranty_months,
  };
}
