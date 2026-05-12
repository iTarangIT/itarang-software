/**
 * E-006 — Daily NBFC CoR expiry alert job.
 *
 * Selects every NBFC whose `cor_expiry_date` falls within the next
 * `windowDays` (default 60), and inserts one row into
 * `nbfc_cor_expiry_alerts` per (nbfc_id, cor_expiry_date) pair. The
 * unique index on that pair guarantees idempotency across daily ticks
 * within the 60-day window — re-running on the same day inserts nothing.
 *
 * Email delivery is intentionally a thin abstraction; the production
 * channel is an SMTP/SES handler injected via `notify`. In tests we
 * default to a no-op so we can assert the DB ledger directly.
 */
import { db } from "@/lib/db";
import { and, gte, lte, isNotNull, eq } from "drizzle-orm";
import { nbfc, nbfcCorExpiryAlerts } from "@/lib/db/schema";

export type CorExpiryAlertRow = {
  nbfcId: number;
  shortName: string;
  corExpiryDate: string;
  daysToExpiry: number;
};

export type CorExpiryNotifier = (rows: CorExpiryAlertRow[]) => Promise<void> | void;

const noopNotifier: CorExpiryNotifier = async () => {
  // intentionally empty — overridden in production wiring.
};

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso + "T00:00:00Z").getTime();
  const to = new Date(toIso + "T00:00:00Z").getTime();
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

export type CheckNbfcCorExpiryOptions = {
  windowDays?: number;
  notify?: CorExpiryNotifier;
};

export type CheckNbfcCorExpiryResult = {
  scanned: number;
  alertsSent: number;
  alreadyAlerted: number;
  rows: CorExpiryAlertRow[];
};

/**
 * Run the daily NBFC CoR expiry scan and insert idempotency rows.
 *
 * Idempotency strategy: the table has a unique index on
 * (nbfc_id, cor_expiry_date). We attempt the insert with
 * `onConflictDoNothing` on each scan. If an insert returned a row,
 * it's a fresh alert; if it returned nothing, the alert already exists
 * and we skip notification for it.
 */
export async function checkNbfcCorExpiryJob(
  opts: CheckNbfcCorExpiryOptions = {},
): Promise<CheckNbfcCorExpiryResult> {
  const windowDays = opts.windowDays ?? 60;
  const notify = opts.notify ?? noopNotifier;

  const today = todayIsoDate();
  const windowEnd = addDaysIso(today, windowDays);

  const candidates = await db
    .select({
      id: nbfc.id,
      short_name: nbfc.short_name,
      cor_expiry_date: nbfc.cor_expiry_date,
    })
    .from(nbfc)
    .where(
      and(
        isNotNull(nbfc.cor_expiry_date),
        gte(nbfc.cor_expiry_date, today),
        lte(nbfc.cor_expiry_date, windowEnd),
      ),
    );

  const fresh: CorExpiryAlertRow[] = [];
  for (const c of candidates) {
    if (!c.cor_expiry_date) continue;
    const raw: unknown = c.cor_expiry_date;
    const expiryIso =
      raw instanceof Date
        ? raw.toISOString().slice(0, 10)
        : String(raw);

    // Try to insert the (nbfc_id, expiry_date) pair. The unique index
    // makes this the idempotency lock — no row returned ⇒ already alerted.
    const inserted = await db
      .insert(nbfcCorExpiryAlerts)
      .values({
        nbfc_id: c.id,
        cor_expiry_date: expiryIso,
      })
      .onConflictDoNothing({
        target: [
          nbfcCorExpiryAlerts.nbfc_id,
          nbfcCorExpiryAlerts.cor_expiry_date,
        ],
      })
      .returning();

    if (inserted.length > 0) {
      fresh.push({
        nbfcId: c.id,
        shortName: c.short_name,
        corExpiryDate: expiryIso,
        daysToExpiry: daysBetween(today, expiryIso),
      });
    }
  }

  if (fresh.length > 0) {
    try {
      await notify(fresh);
    } catch (err) {
      // Notifier failure must NOT roll back the ledger insert — otherwise
      // an SMTP outage would replay the same alert daily. Log and continue.
      // eslint-disable-next-line no-console
      console.error("[E-006] cor-expiry notifier failed:", err);
    }
  }

  return {
    scanned: candidates.length,
    alertsSent: fresh.length,
    alreadyAlerted: candidates.length - fresh.length,
    rows: fresh,
  };
}

/**
 * Test-helper: clear ledger rows for a given nbfc_id. Only intended for
 * the integration tests that need to reset state between AC runs.
 */
export async function clearCorExpiryAlertsForNbfc(nbfcId: number): Promise<void> {
  await db
    .delete(nbfcCorExpiryAlerts)
    .where(eq(nbfcCorExpiryAlerts.nbfc_id, nbfcId));
}
