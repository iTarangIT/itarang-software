// GET/PATCH /api/admin/notification-access — which notification types reach
// which dashboard's in-app bell (E-231).
//
// NOT folded into /api/admin/settings' bundle: that route runs three queries for
// three unrelated tabs, and adding a fourth would make every tab pay for this
// one. This tab loads its own data.
//
// The payload carries only the DENIALS, never the full matrix. Absence of a row
// means enabled (see the E-231 header), and the type list plus every label comes
// from src/lib/notifications/registry.ts, which the client imports directly —
// so ~130 labels never travel over the wire.
//
// SCOPE IS ENFORCED ON BOTH VERBS. `editableDashboardsFor()` is the single rule;
// GET filters the response by it so the client never sees a dashboard it may not
// edit, and PATCH re-derives it so a hand-rolled request cannot write one.

import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { invalidateNotificationAccessCache } from "@/lib/notifications/access";
import {
  DASHBOARDS,
  editableDashboardsFor,
  isKnownType,
} from "@/lib/notifications/registry";

export const dynamic = "force-dynamic";

const EDITOR_ROLES = ["admin", "sales_head", "ceo"];

export const GET = withErrorHandler(async () => {
  const user = await requireRole(EDITOR_ROLES);
  const editable = new Set(editableDashboardsFor(user.role));

  const denied = await db.execute<{ dashboard: string; notification_type: string }>(sql`
    SELECT dashboard, notification_type
      FROM notification_access
     WHERE enabled = FALSE
  `);

  const last = await db.execute<{ updated_at: string; updated_by_name: string | null }>(sql`
    SELECT na.updated_at, u.name AS updated_by_name
      FROM notification_access na
      LEFT JOIN users u ON u.id::text = na.updated_by
     ORDER BY na.updated_at DESC
     LIMIT 1
  `);

  // Roles that real, active logins hold but the registry has never heard of —
  // ops_manager, super_admin, risk_head and friends. They are governed by no
  // dashboard row and are therefore always-on, which is correct fail-open
  // behaviour but completely invisible. Surface it rather than let an admin
  // believe the screen covers everyone.
  const known = new Set(DASHBOARDS.map((d) => d.value));
  const present = await db.execute<{ role: string | null }>(sql`
    SELECT DISTINCT LOWER(role) AS role FROM users WHERE is_active = TRUE
  `);
  const unknown_roles = present
    .map((r) => (r.role ?? "").trim())
    .filter((r) => r && !known.has(r))
    .sort();

  return successResponse({
    dashboards: DASHBOARDS.filter((d) => editable.has(d.value)),
    denied: denied.filter((r) => editable.has(r.dashboard)),
    last_change: last[0] ?? null,
    unknown_roles,
  });
});

const BodySchema = z.object({
  changes: z
    .array(
      z.object({
        dashboard: z
          .string()
          .trim()
          .toLowerCase()
          // Lowercased before it reaches the CHECK in E-231, not after: a
          // mixed-case row would never match LOWER(users.role) and the gate
          // would fail open invisibly.
          .min(1)
          .max(50),
        notification_type: z.string().trim().min(1).max(50),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    // One dashboard's worth of "mute everything" is ~130 rows; this bounds a
    // runaway client without capping any real action.
    .max(2000),
});

export const PATCH = withErrorHandler(async (req: Request) => {
  const user = await requireRole(EDITOR_ROLES);
  const { changes } = BodySchema.parse(await req.json());

  const editable = new Set(editableDashboardsFor(user.role));

  // Reject loudly and by name. A silent drop here would leave the admin looking
  // at a checkbox that says one thing while the database says another.
  const badDashboard = changes.find((c) => !editable.has(c.dashboard));
  if (badDashboard) {
    return errorResponse(
      `You may not change notification access for "${badDashboard.dashboard}".`,
      403,
    );
  }
  const badType = changes.find((c) => !isKnownType(c.notification_type));
  if (badType) {
    return errorResponse(`Unknown notification type "${badType.notification_type}".`, 400);
  }

  // De-dupe on the primary key: postgres rejects an ON CONFLICT statement whose
  // VALUES list hits the same key twice ("cannot affect row a second time"), and
  // a UI that toggles a category then a child inside it can produce exactly that.
  const byKey = new Map<string, (typeof changes)[number]>();
  for (const c of changes) byKey.set(`${c.dashboard}|${c.notification_type}`, c);
  const rows = [...byKey.values()];

  const values = sql.join(
    rows.map(
      (c) =>
        sql`(${c.dashboard}, ${c.notification_type}, ${c.enabled}, ${user.id}, NOW())`,
    ),
    sql`, `,
  );

  await db.execute(sql`
    INSERT INTO notification_access
      (dashboard, notification_type, enabled, updated_by, updated_at)
    VALUES ${values}
    ON CONFLICT (dashboard, notification_type) DO UPDATE
      SET enabled    = EXCLUDED.enabled,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
  `);

  // ONE audit row for the whole save, carrying the diff. The table row itself
  // only ever holds the CURRENT answer — the upsert overwrites — so without this
  // there is no way to see that something was muted and unmuted three times.
  // audit_logs.id is varchar(255) with NO default; forgetting to generate it is
  // a not-null violation, i.e. a 500 on save.
  await db.execute(sql`
    INSERT INTO audit_logs (id, entity_type, entity_id, action, performed_by, new_data)
    VALUES (
      gen_random_uuid()::text,
      'notification_access',
      ${user.id},
      'notification_access.updated',
      ${user.id}::uuid,
      ${JSON.stringify({ changes: rows })}::jsonb
    )
  `);

  // Production runs a single fork, so the emitters share this heap and the next
  // notification sees the change immediately rather than up to a TTL later.
  invalidateNotificationAccessCache();

  return successResponse({ applied: rows.length });
});
