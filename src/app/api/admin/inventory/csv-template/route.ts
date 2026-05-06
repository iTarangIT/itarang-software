import { requireInventoryAdmin } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import {
  ASSET_TYPES,
  AssetType,
  CSV_TEMPLATES,
  buildCsvContent,
} from "@/lib/inventory/csv-templates";
import {
  productMasterBatteries,
  productMasterChargers,
  productMasterParaphernalia,
  products,
} from "@/lib/db/schema";
import { eq } from "drizzle-orm";

function hasPgCode(error: unknown, code: string): boolean {
  let curr: unknown = error;
  while (curr && typeof curr === "object") {
    const rec = curr as { code?: string; cause?: unknown };
    if (rec.code === code) return true;
    curr = rec.cause;
  }
  return false;
}

export async function GET(req: Request) {
  await requireInventoryAdmin();

  const { searchParams } = new URL(req.url);
  const type = (searchParams.get("type") || "") as AssetType;

  if (!ASSET_TYPES.includes(type)) {
    return new Response(
      JSON.stringify({
        success: false,
        error: { message: "type must be battery|charger|paraphernalia" },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const template = structuredClone(CSV_TEMPLATES[type]);

  // Make the downloadable sample row match active masters/catalog so that a
  // newly downloaded template validates out-of-the-box in most environments.
  try {
    if (type === "battery" && template.samples[0]) {
      let chosen:
        | {
            modelId: string;
            modelName: string;
            voltage: string | null;
            capacity: string | null;
            categories: string[];
            subCategories: string[];
          }
        | null = null;

      try {
        const [row] = await db
          .select({
            modelId: productMasterBatteries.model_id,
            modelName: productMasterBatteries.model_name,
            voltage: productMasterBatteries.voltage_v,
            capacity: productMasterBatteries.capacity_ah,
            categories: productMasterBatteries.compatible_categories,
            subCategories: productMasterBatteries.compatible_sub_categories,
          })
          .from(productMasterBatteries)
          .where(eq(productMasterBatteries.status, "active"))
          .limit(1);

        if (row) {
          chosen = {
            modelId: row.modelId,
            modelName: row.modelName,
            voltage: row.voltage ? String(row.voltage) : null,
            capacity: row.capacity ? String(row.capacity) : null,
            categories: (row.categories as string[] | null) ?? [],
            subCategories: (row.subCategories as string[] | null) ?? [],
          };
        }
      } catch (error) {
        if (!hasPgCode(error, "42P01")) throw error;
      }

      if (!chosen) {
        const legacyRows = await db
          .select({
            sku: products.sku,
            name: products.name,
            voltage: products.voltage_v,
            capacity: products.capacity_ah,
            assetType: products.asset_type,
          })
          .from(products)
          .where(eq(products.status, "active"))
          .limit(50);
        const legacy = legacyRows.find((r) =>
          String(r.assetType || "").toLowerCase().includes("battery"),
        );

        if (legacy) {
          chosen = {
            modelId: legacy.sku,
            modelName: legacy.name,
            voltage: legacy.voltage != null ? String(legacy.voltage) : null,
            capacity: legacy.capacity != null ? String(legacy.capacity) : null,
            categories: ["3W"],
            subCategories: [legacy.name || "Battery"],
          };
        }
      }

      if (chosen) {
        template.samples[0][5] = chosen.subCategories[0] || chosen.modelName || "Battery";
        template.samples[0][6] = chosen.modelId;
        if (chosen.voltage) template.samples[0][7] = chosen.voltage;
        if (chosen.capacity) template.samples[0][8] = chosen.capacity;
        if (chosen.categories[0]) template.samples[0][4] = chosen.categories[0];
      }
    }

    if (type === "charger" && template.samples[0]) {
      let modelId: string | null = null;
      try {
        const [row] = await db
          .select({ modelId: productMasterChargers.model_id })
          .from(productMasterChargers)
          .where(eq(productMasterChargers.status, "active"))
          .limit(1);
        modelId = row?.modelId ?? null;
      } catch (error) {
        if (!hasPgCode(error, "42P01")) throw error;
      }
      if (!modelId) {
        const legacyRows = await db
          .select({ sku: products.sku, assetType: products.asset_type })
          .from(products)
          .where(eq(products.status, "active"))
          .limit(50);
        const legacy = legacyRows.find((r) =>
          String(r.assetType || "").toLowerCase().includes("charger"),
        );
        if (legacy) {
          modelId = legacy.sku;
        }
      }
      if (modelId) template.samples[0][1] = modelId;
    }

    if (type === "paraphernalia" && template.samples[0]) {
      try {
        const [row] = await db
          .select({ itemType: productMasterParaphernalia.item_type_code })
          .from(productMasterParaphernalia)
          .where(eq(productMasterParaphernalia.status, "active"))
          .limit(1);
        if (row?.itemType) template.samples[0][0] = row.itemType;
      } catch (error) {
        if (!hasPgCode(error, "42P01")) throw error;
      }
    }
  } catch (error) {
    // Never fail template download because of optional lookup enrichments.
    console.warn(
      "[csv-template] dynamic sample generation failed:",
      error instanceof Error ? error.message : error,
    );
  }

  const csv = buildCsvContent(template);

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="inventory_${type}_template.csv"`,
    },
  });
}
