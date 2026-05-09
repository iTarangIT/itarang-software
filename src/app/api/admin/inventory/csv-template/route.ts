import { requireInventoryAdmin } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import {
  ASSET_TYPES,
  AssetType,
  CSV_TEMPLATES,
} from "@/lib/inventory/csv-templates";
import { productMasterParaphernalia } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";

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

  // Paraphernalia keeps a small enrichment so item_type_code in the example
  // row matches a real active master entry. Battery & charger samples are
  // hardcoded in csv-templates.ts (currently empty by request).
  try {
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
    console.warn(
      "[csv-template] dynamic sample generation failed:",
      error instanceof Error ? error.message : error,
    );
  }

  // Build XLSX so date columns can be locked as Text (numFmt "@"). Excel
  // auto-converts anything that looks like a date in CSV cells; in XLSX
  // with explicit Text formatting the typed value is preserved exactly,
  // which is the only reliable way to keep YYYY-MM-DD round-tripping.
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "iTarang";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(template.type, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = template.headers.map((h) => ({
    header: h,
    key: h,
    width: Math.max(14, h.length + 2),
  }));

  // Header row: bold + light fill for legibility.
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE8F5E9" },
  };

  // Mark date columns as Text so Excel doesn't auto-convert what the admin
  // types into them. Applies to the whole column going forward.
  const dateIdxSet = new Set(template.dateColumnIndexes);
  for (const idx of template.dateColumnIndexes) {
    const col = sheet.getColumn(idx + 1); // ExcelJS columns are 1-based
    col.numFmt = "@";
  }

  // Append any sample rows (paraphernalia keeps one). Date columns are still
  // emitted as plain strings; the Text format above prevents conversion.
  for (const row of template.samples) {
    const obj: Record<string, string> = {};
    template.headers.forEach((h, i) => {
      obj[h] = row[i] ?? "";
    });
    const added = sheet.addRow(obj);
    // Lock date cells in this row to Text explicitly (defensive — column
    // numFmt should suffice but Excel sometimes promotes per-cell format).
    for (const i of dateIdxSet) {
      const cell = added.getCell(i + 1);
      cell.numFmt = "@";
    }
  }

  const buffer = await workbook.xlsx.writeBuffer();

  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="inventory_${type}_template.xlsx"`,
    },
  });
}
