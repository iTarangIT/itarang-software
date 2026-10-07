// GET /api/admin/data-downloads — the catalogue for Reports › Data downloads
// (tracker ID 13): every dataset this role may download, with its filters and
// its column dictionary, plus what this role may do (full phone numbers, see
// the download log), the people the shared `person` filter offers, and this
// person's saved column sets.

import { sql } from "drizzle-orm";

import { requireAuth } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { db } from "@/lib/db";
import { savedColumnSets } from "@/lib/exports/datasets/columnSets";
import { DATASETS, datasetAccess, datasetInfo } from "@/lib/exports/datasets/registry";
import { LEAD_ASSIGNEE_ROLES } from "@/lib/leads/access";
import { BACKGROUND_LINK_HOURS, BACKGROUND_ROW_CAP, DOWNLOAD_LOG_ROLES, DOWNLOAD_ROW_CAP, FULL_PHONE_ROLES } from "@/lib/exports/datasets/types";

export const dynamic = "force-dynamic";

/**
 * The roles whose people own leads, calls, visits, quotes, targets and
 * accounts: every role a lead can be assigned to (LEAD_ASSIGNEE_ROLES — it
 * includes sales_manager and sales_executive), plus the managers who also
 * create quotes and own accounts.
 */
const PERSON_ROLES = [...new Set<string>([...LEAD_ASSIGNEE_ROLES, "admin", "ceo", "business_head"])];

export const GET = withErrorHandler(async () => {
    const user = await requireAuth();
    const role = (user.role ?? "").toLowerCase();
    const datasets = DATASETS.flatMap((d) => {
        const access = datasetAccess(d, role);
        return access ? [{ ...datasetInfo(d), own_only: access.ownOnly }] : [];
    });
    // A rep only ever gets its own rows, so it is offered nobody to pick.
    const seesEveryone = datasets.some((d) => !d.own_only && d.commonFilters?.includes("person"));
    const [people, saved_columns] = await Promise.all([
        seesEveryone
            ? (db.execute(sql`
                  -- Deactivated people too (listed last, marked inactive): their
                  -- leads, calls and visits are still in the data.
                  SELECT id::text AS id, name, role, (is_active IS FALSE) AS inactive FROM users
                   WHERE role IN (${sql.join(PERSON_ROLES.map((r) => sql`${r}`), sql`, `)})
                   ORDER BY (is_active IS FALSE), name
              `) as unknown as Promise<Array<{ id: string; name: string | null; role: string; inactive: boolean }>>)
            : Promise.resolve([]),
        savedColumnSets(user.id),
    ]);
    return successResponse({
        datasets,
        people,
        saved_columns,
        row_cap: DOWNLOAD_ROW_CAP,
        background_row_cap: BACKGROUND_ROW_CAP,
        background_link_hours: BACKGROUND_LINK_HOURS,
        can_full_phone: (FULL_PHONE_ROLES as readonly string[]).includes(role),
        can_see_log: (DOWNLOAD_LOG_ROLES as readonly string[]).includes(role),
    });
});
