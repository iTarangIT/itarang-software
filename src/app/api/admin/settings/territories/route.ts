// POST /api/admin/settings/territories — map an ASM to a state/city (BRD §0.8).
// This is the admin UI that replaces the seed-script-only territory setup
// Modules 1–2 relied on.

import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import {
    errorResponse,
    successResponse,
    withErrorHandler,
} from "@/lib/api-utils";

import { users, asmTerritories } from "@/lib/db/schema";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

const BodySchema = z.object({
    asm_id: z.string().min(1),
    state: z.string().trim().min(2).max(100),
    city: z.string().trim().min(1).max(100).optional().nullable(),
    active_from: z.string().regex(DATE).optional().nullable(),
    active_to: z.string().regex(DATE).optional().nullable(),
});

export const POST = withErrorHandler(async (req: Request) => {
    await requireRole(["admin", "sales_head"]);
    const b = BodySchema.parse(await req.json());

    const asm = await db.execute<{ id: string; role: string | null }>(sql`
        SELECT id::text AS id, role FROM ${users} WHERE id::text = ${b.asm_id} LIMIT 1
    `);
    if (!asm[0]) return errorResponse("ASM user not found.", 404);
    if ((asm[0].role ?? "").toLowerCase() !== "asm") {
        return errorResponse("Selected user is not an ASM.", 400);
    }

    await db.execute(sql`
        INSERT INTO ${asmTerritories} (asm_id, state, city, active_from, active_to)
        VALUES (${b.asm_id}, ${b.state}, ${b.city ?? null},
            ${b.active_from ?? null}, ${b.active_to ?? null})
    `);

    return successResponse({ ok: true });
});
