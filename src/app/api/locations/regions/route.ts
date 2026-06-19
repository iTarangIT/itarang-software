// GET /api/locations/regions — canonical state + city reference lists for
// region dropdowns (E-108/E-110/E-111 reference tables). Returns every state
// and the cities grouped under each, so a client can drive a cascading
// State → City selector without per-keystroke queries.

import { asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { states, cities } from "@/lib/db/schema";
import { requireAuth } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";

export const dynamic = "force-dynamic";

export interface RegionsResponse {
    states: { code: string; name: string }[];
    citiesByState: Record<string, string[]>;
}

export const GET = withErrorHandler(async () => {
    // Reference lists are not sensitive, but keep them behind auth so only
    // signed-in dashboard users hit the DB.
    await requireAuth();

    const [stateRows, cityRows] = await Promise.all([
        db
            .select({ code: states.code, name: states.name })
            .from(states)
            .orderBy(asc(states.name)),
        db
            .select({ name: cities.name, state_code: cities.state_code })
            .from(cities)
            .orderBy(asc(cities.name)),
    ]);

    const citiesByState: Record<string, string[]> = {};
    for (const c of cityRows) {
        (citiesByState[c.state_code] ??= []).push(c.name);
    }

    return successResponse({
        states: stateRows,
        citiesByState,
    } satisfies RegionsResponse);
});
