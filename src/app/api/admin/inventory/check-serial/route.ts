import { db } from "@/lib/db";
import { inventory } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { requireInventoryAdmin } from "@/lib/auth-utils";
import { successResponse, errorResponse, withErrorHandler } from "@/lib/api-utils";

export const GET = withErrorHandler(async (req: Request) => {
  await requireInventoryAdmin();

  const { searchParams } = new URL(req.url);
  const serial = (searchParams.get("serial") || "").trim();

  if (!serial) {
    return errorResponse("serial is required", 400);
  }

  const [dup] = await db
    .select({ id: inventory.id })
    .from(inventory)
    .where(eq(inventory.serial_number, serial))
    .limit(1);

  return successResponse({ exists: Boolean(dup) });
});
