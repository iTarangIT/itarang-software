/**
 * Threshold rules — read via getAlertsView(), written here.
 *
 *   PUT    edit the tunable fields of one rule
 *   POST   create a per-source override
 *   DELETE remove a per-source override
 *
 * Rules are seeded from registry.ts defaults on first sight and owned by
 * whoever edits them afterwards. seedAlertRules() uses ON CONFLICT DO NOTHING
 * precisely so a threshold tuned here survives every subsequent deploy.
 *
 * metric_key, source and comparator are fixed once a rule exists. The
 * comparator encodes "which way is bad", which is a property of the metric
 * (registry.ts owns it), and letting a rule disagree with its metric would
 * invert the alert without anything looking wrong. On POST the comparator is
 * therefore DERIVED from the registry rather than accepted from the client.
 *
 * WILDCARD vs OVERRIDE. source '*' means "every source of this metric". A rule
 * naming a specific source shadows '*' for that source alone — see
 * alertRouting.ts. Only overrides can be created and deleted here: the '*' rows
 * belong to the seeder, which would simply recreate a deleted one on the next
 * tick.
 */

import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { ANY_SOURCE } from "@/lib/operations/alertRouting";
import {
  comparatorFor,
  getMetric,
  thresholdOrderError,
} from "@/lib/operations/registry";
import { requireOperationsAdmin } from "@/lib/operations/route-guard";

export const dynamic = "force-dynamic";

const rows = async (
  query: ReturnType<typeof sql>,
): Promise<Array<Record<string, unknown>>> =>
  (await db.execute(query)) as unknown as Array<Record<string, unknown>>;

const num = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const bad = (message: string, status = 400) =>
  NextResponse.json({ success: false, error: { message } }, { status });

const failed = (e: unknown, fallback: string) =>
  NextResponse.json(
    {
      success: false,
      error: { message: e instanceof Error ? e.message : fallback },
    },
    { status: 500 },
  );

async function parseBody<T extends z.ZodTypeAny>(
  request: NextRequest,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: bad("Body must be JSON") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      response: bad(
        `${issue?.path?.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

// Zero would mean "notify every tick", which is how a flapping metric mails the
// team 1,440 times a day. One minute is the floor.
const cooldown = z.number().int().min(1).max(10_080);
const channels = z.array(z.enum(["inapp", "email"]));
// null clears a threshold — a metric can legitimately warn but never crit.
const threshold = z.number().finite().nullable();

// ---------------------------------------------------------------------------
// PUT — edit
// ---------------------------------------------------------------------------

const PutBody = z.object({
  id: z.string().uuid(),
  warn_threshold: threshold.optional(),
  crit_threshold: threshold.optional(),
  enabled: z.boolean().optional(),
  cooldown_minutes: cooldown.optional(),
  notify_channels: channels.optional(),
});

export async function PUT(request: NextRequest) {
  const auth = await requireOperationsAdmin();
  if (!auth.ok) return auth.response;

  const parsed = await parseBody(request, PutBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  try {
    // Read first, so the resulting pair can be validated as a whole: a PUT that
    // only moves `warn` still has to sit correctly against the stored `crit`.
    const [existing] = await rows(sql`
      SELECT comparator, warn_threshold, crit_threshold
      FROM ops_alert_rules WHERE id = ${body.id}::uuid
    `);
    if (!existing) return bad("Rule not found", 404);

    const warn =
      body.warn_threshold === undefined
        ? num(existing.warn_threshold)
        : body.warn_threshold;
    const crit =
      body.crit_threshold === undefined
        ? num(existing.crit_threshold)
        : body.crit_threshold;

    const orderError = thresholdOrderError(String(existing.comparator), warn, crit);
    if (orderError) return bad(orderError);

    // COALESCE against the existing row so an omitted field keeps its value —
    // a PUT that only changes the cooldown must not blank the thresholds.
    const updated = await rows(sql`
      UPDATE ops_alert_rules SET
        warn_threshold   = ${body.warn_threshold === undefined ? sql`warn_threshold` : body.warn_threshold},
        crit_threshold   = ${body.crit_threshold === undefined ? sql`crit_threshold` : body.crit_threshold},
        enabled          = COALESCE(${body.enabled ?? null}, enabled),
        cooldown_minutes = COALESCE(${body.cooldown_minutes ?? null}, cooldown_minutes),
        notify_channels  = COALESCE(${body.notify_channels ? JSON.stringify(body.notify_channels) : null}::jsonb, notify_channels),
        updated_at       = NOW()
      WHERE id = ${body.id}::uuid
      RETURNING id, metric_key, source, warn_threshold, crit_threshold,
                enabled, cooldown_minutes, notify_channels
    `);

    if (updated.length === 0) return bad("Rule not found", 404);
    return NextResponse.json({ success: true, data: updated[0] });
  } catch (e) {
    return failed(e, "Failed to update rule");
  }
}

// ---------------------------------------------------------------------------
// POST — create a per-source override
// ---------------------------------------------------------------------------

const PostBody = z.object({
  metric_key: z.string().min(1).max(120),
  // varchar(80) in E-210; the collectors slice() to the same width.
  source: z.string().min(1).max(80),
  warn_threshold: threshold.optional(),
  crit_threshold: threshold.optional(),
  cooldown_minutes: cooldown.optional(),
  notify_channels: channels.optional(),
  enabled: z.boolean().optional(),
});

export async function POST(request: NextRequest) {
  const auth = await requireOperationsAdmin();
  if (!auth.ok) return auth.response;

  const parsed = await parseBody(request, PostBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  // The metric must exist in the registry: the comparator, unit and label all
  // come from there, and a rule on an unknown key would evaluate against
  // samples nothing writes while looking perfectly healthy on the page.
  const metric = getMetric(body.metric_key);
  if (!metric) return bad(`Unknown metric: ${body.metric_key}`);

  // The wildcard row is the seeder's. Creating one here would race
  // seedAlertRules() for the same (metric_key, source) and muddy which of the
  // two owns the thresholds — edit the existing '*' rule instead.
  if (body.source === ANY_SOURCE) {
    return bad(
      `source '${ANY_SOURCE}' is the seeded default — edit that rule rather than creating another. This endpoint creates per-source overrides.`,
    );
  }

  const warn = body.warn_threshold ?? null;
  const crit = body.crit_threshold ?? null;

  // A rule with neither threshold can never fire, and because it shadows the
  // '*' rule for its source it would silently STOP that source being monitored
  // — strictly worse than not creating it.
  if (warn == null && crit == null) {
    return bad(
      "An override needs at least one threshold. With neither it can never fire, and it would shadow the '*' rule and leave this source unmonitored.",
    );
  }

  const comparator = comparatorFor(metric);
  const orderError = thresholdOrderError(comparator, warn, crit);
  if (orderError) return bad(orderError);

  try {
    const created = await rows(sql`
      INSERT INTO ops_alert_rules
        (metric_key, source, comparator, warn_threshold, crit_threshold,
         enabled, cooldown_minutes, notify_channels)
      VALUES (
        ${body.metric_key}, ${body.source}, ${comparator}, ${warn}, ${crit},
        ${body.enabled ?? true}, ${body.cooldown_minutes ?? 60},
        ${JSON.stringify(body.notify_channels ?? ["inapp"])}::jsonb
      )
      ON CONFLICT (metric_key, source) DO NOTHING
      RETURNING id, metric_key, source, comparator, warn_threshold,
                crit_threshold, enabled, cooldown_minutes, notify_channels
    `);

    // DO NOTHING returns no row when the pair already exists — a conflict, not
    // a success, and the caller needs to know it edited nothing.
    if (created.length === 0) {
      return bad(
        `A rule already exists for ${body.metric_key} on ${body.source}. Edit it instead.`,
        409,
      );
    }

    return NextResponse.json({ success: true, data: created[0] }, { status: 201 });
  } catch (e) {
    return failed(e, "Failed to create rule");
  }
}

// ---------------------------------------------------------------------------
// DELETE — remove a per-source override
// ---------------------------------------------------------------------------

const DeleteBody = z.object({ id: z.string().uuid() });

export async function DELETE(request: NextRequest) {
  const auth = await requireOperationsAdmin();
  if (!auth.ok) return auth.response;

  const parsed = await parseBody(request, DeleteBody);
  if (!parsed.ok) return parsed.response;

  try {
    const [existing] = await rows(sql`
      SELECT source FROM ops_alert_rules WHERE id = ${parsed.data.id}::uuid
    `);
    if (!existing) return bad("Rule not found", 404);

    // Deleting a '*' row is a no-op with a gap in the middle: seedAlertRules()
    // recreates it on the next tick, but from the REGISTRY defaults, silently
    // discarding whatever it had been tuned to. Disable it instead.
    if (String(existing.source) === ANY_SOURCE) {
      return bad(
        `Cannot delete the '${ANY_SOURCE}' rule — the seeder would recreate it from the registry defaults on the next tick, discarding your thresholds. Disable it instead.`,
      );
    }

    const deleted = await rows(sql`
      DELETE FROM ops_alert_rules WHERE id = ${parsed.data.id}::uuid
      RETURNING id, metric_key, source
    `);
    if (deleted.length === 0) return bad("Rule not found", 404);

    // ops_alerts.rule_id is deliberately not a foreign key, so alert history
    // outlives the rule that raised it. Any alert still open for this source is
    // handed back to the '*' rule on the next tick and resolves normally under
    // its thresholds.
    return NextResponse.json({ success: true, data: deleted[0] });
  } catch (e) {
    return failed(e, "Failed to delete rule");
  }
}
