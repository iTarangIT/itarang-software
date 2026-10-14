// GET /api/admin/reports/sales-drill — the rows behind one number on the Sales
// dashboard (src/lib/dashboard/salesDrill.ts).
//
//   ?kind=<DrillKind>          which number (calls, visits, dealer_yes, …)
//   &person=<id>               one person's cell ("__none__" = no person)
//   &persons=<id>,<id>,…       a whole column, as on screen
//   &key=<reason|stage>        Why we lost / Ecofy stage
//   &from=&to=&state=&city=&business_type=&spoc_id=   the screen's filters
//   &format=csv                every row (up to 20,000) as a CSV file
//
// JSON returns the first 500 rows. Same roles as the Sales dashboard; the
// Ecofy kinds only for the Ecofy managers, like the Ecofy tile.

import { z } from "zod";

import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { ECOFY_MANAGER_ROLES } from "@/lib/ecofy/access";
import { csvDateTime, csvResponse } from "@/lib/leads/queueCsv";
import { LEAD_STATUS_LABEL } from "@/lib/leads/queueFilters";
import {
    DRILL_KINDS,
    DRILL_TITLES,
    ECOFY_DRILL_KINDS,
    salesDrillRows,
    type DrillFilters,
    type DrillRow,
} from "@/lib/dashboard/salesDrill";

export const dynamic = "force-dynamic";

const READ_ROLES = ["admin", "ceo", "sales_head", "business_head", "partner"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const CSV_MAX = 20000;

const pretty = (v: string | null | undefined) => (v ? v.replace(/_/g, " ") : "");
const statusText = (v: string | null) => (v && (LEAD_STATUS_LABEL as Record<string, string>)[v]) || pretty(v);

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireRole(READ_ROLES);
    const p = new URL(req.url).searchParams;
    const kind = z.enum(DRILL_KINDS).safeParse(p.get("kind"));
    if (!kind.success) return errorResponse("Unknown number.", 400);
    if (ECOFY_DRILL_KINDS.includes(kind.data) && !(ECOFY_MANAGER_ROLES as readonly string[]).includes(String(user.role ?? "").toLowerCase())) {
        return errorResponse("Ecofy leads are for the Sales Head and CEO.", 403);
    }
    // Ecofy counts are "as of now" (no period); every other number needs one.
    const eco = ECOFY_DRILL_KINDS.includes(kind.data);
    const today = new Date().toISOString().slice(0, 10);
    const from = p.get("from") ?? (eco ? today : "");
    const to = p.get("to") ?? (eco ? today : "");
    if (!ISO.test(from) || !ISO.test(to) || from > to) return errorResponse("Pick a valid date range.", 400);
    const opt = (k: string) => p.get(k)?.trim() || null;
    const f: DrillFilters = { from, to, state: opt("state"), city: opt("city"), business_type: opt("business_type"), spoc_id: opt("spoc_id") };
    const persons = [...(p.get("persons") ?? "").split(","), p.get("person") ?? ""]
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.length <= 100)
        .slice(0, 500);
    const key = opt("key");

    if (p.get("format") === "csv") {
        const rows = await salesDrillRows(kind.data, f, { persons: persons.length ? persons : null, key, limit: CSV_MAX + 1 });
        const slug = `${DRILL_TITLES[kind.data]}${key ? ` ${key}` : ""}`.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        return csvResponse<DrillRow>({
            rows: rows.slice(0, CSV_MAX),
            total: rows.length,
            filename: slug,
            columns: [
                { header: "Person (counted for)", value: (r) => r.person_name ?? (r.person_id ? r.person_id : "") },
                { header: "ID", value: (r) => r.id },
                { header: "Name", value: (r) => r.name },
                { header: "Phone", value: (r) => r.phone ?? "" },
                { header: "City", value: (r) => r.city ?? "" },
                { header: "State", value: (r) => r.state ?? "" },
                { header: "Status", value: (r) => statusText(r.status) },
                { header: "Rating", value: (r) => r.rating ?? "" },
                { header: "Current owner / dealer", value: (r) => r.owner_name ?? "" },
                { header: "When", value: (r) => csvDateTime(r.at) },
                { header: "Detail", value: (r) => r.detail ?? "" },
            ],
        });
    }

    const rows = await salesDrillRows(kind.data, f, { persons: persons.length ? persons : null, key, limit: 500 });
    return successResponse({ title: DRILL_TITLES[kind.data], rows });
});
