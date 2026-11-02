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
import { canonicalTerritoryPlace, overlappingAsms } from "@/lib/ai-dialer/territoryRouting";

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
        SELECT id::text AS id, role FROM users WHERE id::text = ${b.asm_id} LIMIT 1
    `);
    if (!asm[0]) return errorResponse("ASM user not found.", 404);
    if ((asm[0].role ?? "").toLowerCase() !== "asm") {
        return errorResponse("Selected user is not an ASM.", 400);
    }

    // E-367 — territories drive automatic lead routing, so the place is stored
    // the way the lead writers store it, and a state we don't know is refused
    // (a typo would silently never match a lead).
    const place = await canonicalTerritoryPlace({ state: b.state, city: b.city ?? null });
    if (place.unknownState) {
        return errorResponse(`"${b.state}" is not a state we know. Check the spelling.`, 400);
    }
    const overlap = await overlappingAsms({ state: place.state, city: place.city, exceptAsmId: b.asm_id });

    await db.execute(sql`
        INSERT INTO asm_territories (asm_id, state, city, active_from, active_to)
        VALUES (${b.asm_id}, ${place.state}, ${place.city},
            ${b.active_from ?? null}, ${b.active_to ?? null})
    `);

    return successResponse({ ok: true, state: place.state, city: place.city, overlap });
});
