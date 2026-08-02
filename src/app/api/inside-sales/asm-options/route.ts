// GET /api/inside-sales/asm-options?state=...&city=...&include_out_of_territory=true
// Drives the Transfer-to-ASM dropdown (BRD §0.8).
// Returns ASMs whose territory matches the dealer's state/city, plus an
// "in_territory" flag so the UI can label out-of-territory rows.

import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import type { AsmOption } from "@/lib/inside-sales/types";

import { users, asmTerritories } from "@/lib/db/schema";

const READ_ROLES = [
    "inside_sales_rep",
    "admin",
    "ceo",
    "sales_manager",
    "sales_head",
    "business_head",
];

const QuerySchema = z.object({
    state: z.string().trim().min(1).max(100).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    include_out_of_territory: z.coerce.boolean().default(false),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
    await requireRole(READ_ROLES);
    const url = new URL(req.url);
    const parsed = QuerySchema.parse({
        state: url.searchParams.get("state") ?? undefined,
        city: url.searchParams.get("city") ?? undefined,
        include_out_of_territory: url.searchParams.get("include_out_of_territory") ?? undefined,
    });

    // Active ASMs with their territory match flag.
    const rows = await db.execute<{
        user_id: string;
        name: string | null;
        email: string;
        in_territory: boolean;
    }>(sql`
        SELECT
            u.id::text AS user_id,
            u.name,
            u.email,
            EXISTS (
                SELECT 1 FROM ${asmTerritories} t
                WHERE t.asm_id = u.id::text
                  AND (${parsed.state ?? null}::text IS NULL OR t.state = ${parsed.state ?? null})
                  AND (
                      ${parsed.city ?? null}::text IS NULL
                      OR t.city IS NULL
                      OR t.city = ${parsed.city ?? null}
                  )
                  AND (t.active_from IS NULL OR t.active_from <= CURRENT_DATE)
                  AND (t.active_to IS NULL OR t.active_to >= CURRENT_DATE)
            ) AS in_territory
        FROM ${users} u
        WHERE LOWER(u.role) = 'asm' AND u.is_active = TRUE
        ORDER BY u.name ASC
    `);

    const asms: AsmOption[] = rows.map((r) => ({
        user_id: r.user_id,
        name: r.name,
        email: r.email,
        in_territory: Boolean(r.in_territory),
    }));

    const filtered = parsed.include_out_of_territory
        ? asms
        : asms.filter((a) => a.in_territory);

    return successResponse({ asms: filtered, total_asms: asms.length });
});
