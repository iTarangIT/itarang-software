import { requireInventoryAdmin } from "@/lib/auth-utils";
import {
  ASSET_TYPES,
  AssetType,
  CSV_TEMPLATES,
  buildCsvContent,
} from "@/lib/inventory/csv-templates";

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

  const template = CSV_TEMPLATES[type];
  const csv = buildCsvContent(template);

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="inventory_${type}_template.csv"`,
    },
  });
}
