import { db } from "@/lib/db";
import { inventory } from "@/lib/db/schema";
import { like } from "drizzle-orm";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";

export const GET = withErrorHandler(async (req: Request) => {
  await requireInventoryAdmin();

  const { searchParams } = new URL(req.url);
  const assetType = searchParams.get("assetType");
  const modelId = (searchParams.get("modelId") || "").trim();

  if (assetType !== "battery" && assetType !== "charger") {
    return errorResponse("assetType must be 'battery' or 'charger'", 400);
  }
  if (!modelId) {
    return errorResponse("modelId is required", 400);
  }

  // Escape LIKE wildcards in the modelId so a value like "BAT_X" doesn't
  // accidentally match "BAT-X". `\` escapes _ and %.
  const escaped = modelId.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
  const rows = await db
    .select({ serial_number: inventory.serial_number })
    .from(inventory)
    .where(like(inventory.serial_number, `${escaped}-%`));

  const suffixRe = new RegExp(
    `^${modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`,
  );
  let max = 0;
  for (const r of rows) {
    const s = r.serial_number;
    if (!s) continue;
    const m = s.match(suffixRe);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }

  const next = (max + 1).toString().padStart(4, "0");
  return successResponse({ suggestedSerial: `${modelId}-${next}` });
});
