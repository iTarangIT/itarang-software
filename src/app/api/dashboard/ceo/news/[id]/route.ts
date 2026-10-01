// PATCH /api/dashboard/ceo/news/[id] — "Not relevant" (E-306). CEO only.
// Body: { hidden: boolean }. A hidden row never shows again but is kept so the
// next fetch does not re-import it.

import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { greenNewsItems } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ hidden: z.boolean() });

export const PATCH = withErrorHandler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    await requireRole(["ceo"]);
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return errorResponse("Bad id", 400);
    const body = bodySchema.parse(await req.json());

    const [row] = await db
      .update(greenNewsItems)
      .set({ hidden: body.hidden })
      .where(eq(greenNewsItems.id, id))
      .returning({ id: greenNewsItems.id, hidden: greenNewsItems.hidden });
    if (!row) return errorResponse("Not found", 404);
    return successResponse(row);
  },
);
