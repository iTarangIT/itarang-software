// GET/PATCH /api/admin/notification-email — which notification types ALSO go out
// by email (E-284). The email-channel sibling of /api/admin/notification-access.
//
// The payload carries only the OVERRIDES plus the code's own defaults-off list,
// never the full matrix: the type vocabulary and all ~200 labels come from
// src/lib/notifications/registry.ts, which the client imports directly, so they
// never travel over the wire. Same trick as the access route.
//
// WHY `defaults_off` IS SENT RATHER THAN COMPUTED ON THE CLIENT.
// emailWorthy() is importable client-side, but the screen must render the
// BASELINE the server will actually apply. Shipping the list means one answer,
// derived once, on the side that owns it — and it keeps the client from having
// to know that buyback types are excluded by a separate predicate.

import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { requireRole } from "@/lib/auth-utils";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { invalidateEmailAccessCache } from "@/lib/notifications/email-access";
import {
  emailLockedTypes,
  emailWorthy,
  isEmailLocked,
} from "@/lib/notifications/catalog";
import { allGovernableTypes, isKnownType } from "@/lib/notifications/registry";

export const dynamic = "force-dynamic";

// The same three roles that may edit Notification Access may edit this, and for
// the same reason: this page is the notification owner's screen, and sales_head
// is its primary user (the page itself gates ["admin","sales_head"]).
//
// It is worth being clear about what that grants, because it is WIDER than the
// bell tab. There, editableDashboardsFor() confines sales_head to 10 dashboards.
// Email has no dashboard axis at all — emit()'s emailTargets() sends ONE message
// to every resolved target — so any edit here is global by construction. The
// blast radius is bounded instead by EMAIL_LOCKED and by the bespoke senders in
// src/lib/email/, neither of which this route can touch.
const VIEWER_ROLES = ["admin", "sales_head", "ceo"];
const EDITOR_ROLES = ["admin", "sales_head", "ceo"];

export const GET = withErrorHandler(async () => {
  const user = await requireRole(VIEWER_ROLES);

  const overrides = await db.execute<{ notification_type: string; enabled: boolean }>(sql`
    SELECT notification_type, enabled
      FROM notification_email_access
  `);

  const last = await db.execute<{ updated_at: string; updated_by_name: string | null }>(sql`
    SELECT nea.updated_at, u.name AS updated_by_name
      FROM notification_email_access nea
      LEFT JOIN users u ON u.id::text = nea.updated_by
     ORDER BY nea.updated_at DESC
     LIMIT 1
  `);

  return successResponse({
    overrides,
    // The types emailWorthy() suppresses in code — the screen's unticked
    // baseline wherever no override exists.
    defaults_off: allGovernableTypes().filter((t) => !emailWorthy(t)),
    locked: emailLockedTypes(),
    last_change: last[0] ?? null,
    can_edit: EDITOR_ROLES.includes(user.role),
  });
});

const BodySchema = z.object({
  changes: z
    .array(
      z.object({
        notification_type: z.string().trim().min(1).max(50),
        enabled: z.boolean(),
      }),
    )
    .min(1)
    // "Turn the whole catalogue off" is ~200 rows; this bounds a runaway client
    // without capping any real action.
    .max(500),
});

export const PATCH = withErrorHandler(async (req: Request) => {
  const user = await requireRole(EDITOR_ROLES);
  const { changes } = BodySchema.parse(await req.json());

  // Reject loudly and BY NAME, like the access route's dashboard check. A silent
  // drop would leave the admin looking at a checkbox that says one thing while
  // the database says another.
  const badType = changes.find((c) => !isKnownType(c.notification_type));
  if (badType) {
    return errorResponse(`Unknown notification type "${badType.notification_type}".`, 400);
  }
  const locked = changes.find((c) => isEmailLocked(c.notification_type));
  if (locked) {
    return errorResponse(
      `"${locked.notification_type}" is always emailed and cannot be changed here — ` +
        `it is the only copy the recipient gets.`,
      403,
    );
  }

  // De-dupe on the primary key: postgres rejects an ON CONFLICT statement whose
  // VALUES list hits the same key twice ("cannot affect row a second time"), and
  // a UI that toggles a category then a child inside it produces exactly that.
  const byKey = new Map<string, (typeof changes)[number]>();
  for (const c of changes) byKey.set(c.notification_type, c);
  const rows = [...byKey.values()];

  const values = sql.join(
    rows.map((c) => sql`(${c.notification_type}, ${c.enabled}, ${user.id}, NOW())`),
    sql`, `,
  );

  await db.execute(sql`
    INSERT INTO notification_email_access
      (notification_type, enabled, updated_by, updated_at)
    VALUES ${values}
    ON CONFLICT (notification_type) DO UPDATE
      SET enabled    = EXCLUDED.enabled,
          updated_by = EXCLUDED.updated_by,
          updated_at = NOW()
  `);

  // ONE audit row for the whole save, carrying the diff. The table row itself
  // only ever holds the CURRENT answer — the upsert overwrites — so without this
  // there is no way to see that a channel was turned off and on three times.
  // audit_logs.id is varchar(255) with NO default; forgetting to generate it is
  // a not-null violation, i.e. a 500 on save.
  await db.execute(sql`
    INSERT INTO audit_logs (id, entity_type, entity_id, action, performed_by, new_data)
    VALUES (
      gen_random_uuid()::text,
      'notification_email_access',
      ${user.id},
      'notification_email_access.updated',
      ${user.id}::uuid,
      ${JSON.stringify({ changes: rows })}::jsonb
    )
  `);

  // Production runs a single fork, so the emitters share this heap and the next
  // notification sees the change immediately rather than up to a TTL later.
  invalidateEmailAccessCache();

  return successResponse({ applied: rows.length });
});
