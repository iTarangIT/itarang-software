/**
 * E-217 — currency conversion for expenses.
 *
 * `expense_submissions.amount` is a single numeric column that every dashboard
 * SUMs with no notion of currency, so anything not in rupees must be converted
 * before it is stored. A $200 invoice added to a rupee total as 200 does not
 * just understate spend — it produces a number denominated in nothing.
 *
 * Rates are keyed by the INVOICE's date, not today's. An expense belongs to the
 * month it was incurred (E-216 made the dashboard bucket that way), so
 * converting a May bill at today's rate would make last month's total drift
 * every time it was recomputed. Cached in `fx_rates`, so the same invoice
 * always converts to the same rupee figure.
 *
 * Source is the ECB daily reference rate via frankfurter.app — no API key, no
 * account, no quota. Deliberately mid-market: the booked expense should match
 * the vendor's invoice, which is what an audit will compare against. The card's
 * forex markup is a banking cost, not part of what was purchased.
 */
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings, fxRates } from "@/lib/db/schema";
import {
  BASE_CURRENCY,
  EMERGENCY_FALLBACK_RATES,
  isBaseCurrency,
  round2,
} from "@/lib/expenses/currency";

// Re-exported so callers have one import for currency concerns; the pure half
// lives in ./currency so the vitest suite (no-I/O only) can load it.
export { BASE_CURRENCY, isBaseCurrency } from "@/lib/expenses/currency";

/**
 * Give up rather than hang the scan; the fallback rate covers the failure.
 * Generous because a cold historical lookup has been measured at ~1.2s and the
 * provider occasionally stalls on first contact — a premature abort would drop
 * every row to the approximate fallback for no reason.
 */
const FETCH_TIMEOUT_MS = 20_000;


export interface ConversionResult {
  /** INR figure to store in `amount`. */
  amountInr: number;
  /** Units of INR per 1 unit of the source currency. */
  rate: number;
  /** The date whose rate was used (may precede the invoice date over a weekend). */
  rateDate: string | null;
  source: "none" | "ecb" | "fallback" | "manual";
  /** Set when the figure is approximate and a human should confirm it. */
  warning: string | null;
}

/**
 * Convert `amount` from `currency` to INR using the rate for `onDate`.
 *
 * Never throws: a conversion this cannot do accurately still returns a usable
 * figure plus a warning, because dropping the expense entirely would understate
 * spend far more badly than approximating it.
 */
export async function convertToInr(
  amount: number,
  currency: string | null | undefined,
  onDate: string | null,
): Promise<ConversionResult> {
  if (isBaseCurrency(currency)) {
    return { amountInr: amount, rate: 1, rateDate: null, source: "none", warning: null };
  }

  const code = currency!.trim().toUpperCase();
  // No invoice date (the extractor could not read one) — today's rate is the
  // only defensible choice, and the row is already flagged for the missing date.
  const date = onDate ?? new Date().toISOString().slice(0, 10);

  const found = await resolveRate(code, date);
  const amountInr = round2(amount * found.rate);

  return {
    amountInr,
    rate: found.rate,
    rateDate: found.rateDate,
    source: found.source,
    warning:
      found.source !== "fallback"
        ? null
        : found.rate === 1
          ? `No exchange rate is available for ${code}, so ${amount} was booked as ₹${amount} — almost certainly wrong. Enter the correct INR amount, or add a "${code}" rate under the fx_rates_fallback setting.`
          : `Converted ${code} ${amount} at an approximate rate of ${found.rate} because the live rate lookup failed. Check it against the card statement.`,
  };
}

interface ResolvedRate {
  rate: number;
  rateDate: string | null;
  source: "ecb" | "fallback" | "manual";
}

async function resolveRate(code: string, date: string): Promise<ResolvedRate> {
  const cached = await readCachedRate(code, date);
  if (cached) return cached;

  const fetched = await fetchEcbRate(code, date);
  if (fetched) {
    await cacheRate(code, fetched.rateDate!, fetched.rate, "ecb");
    // Also store under the requested date when the provider rolled back to a
    // business day, so the same invoice never re-fetches.
    if (fetched.rateDate !== date) {
      await cacheRate(code, date, fetched.rate, "ecb");
    }
    return fetched;
  }

  const configured = await readConfiguredRate(code);
  if (configured != null) {
    return { rate: configured, rateDate: null, source: "fallback" };
  }

  const emergency = EMERGENCY_FALLBACK_RATES[code];
  if (emergency != null) {
    return { rate: emergency, rateDate: null, source: "fallback" };
  }

  // Unknown currency and no rate anywhere: 1:1 keeps the row importable and the
  // warning makes it obvious the figure is wrong.
  return { rate: 1, rateDate: null, source: "fallback" };
}

async function readCachedRate(code: string, date: string): Promise<ResolvedRate | null> {
  try {
    const [row] = await db
      .select()
      .from(fxRates)
      .where(
        and(
          eq(fxRates.base_currency, code),
          eq(fxRates.quote_currency, BASE_CURRENCY),
          eq(fxRates.rate_date, date),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      rate: Number(row.rate),
      rateDate: row.rate_date,
      source: row.source === "manual" ? "manual" : row.source === "ecb" ? "ecb" : "fallback",
    };
  } catch (err) {
    console.error("[fx] cache read failed:", errText(err));
    return null;
  }
}

async function cacheRate(
  code: string,
  date: string,
  rate: number,
  source: "ecb" | "manual" | "fallback",
): Promise<void> {
  try {
    await db
      .insert(fxRates)
      .values({
        base_currency: code,
        quote_currency: BASE_CURRENCY,
        rate_date: date,
        rate: String(rate),
        source,
      })
      .onConflictDoNothing();
  } catch (err) {
    // A cache miss is survivable; a failed insert must not fail the import.
    console.error("[fx] cache write failed:", errText(err));
  }
}

/**
 * ECB daily reference rate for a date.
 *
 * frankfurter.app returns the preceding business day when asked for a weekend
 * or holiday, and reports which date it actually used — that returned date is
 * what gets cached, so the rate is honest about where it came from.
 */
async function fetchEcbRate(
  code: string,
  date: string,
): Promise<ResolvedRate | null> {
  const url = `https://api.frankfurter.app/${encodeURIComponent(date)}?from=${encodeURIComponent(code)}&to=${BASE_CURRENCY}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      console.error(`[fx] ${code}->INR ${date}: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as {
      date?: string;
      rates?: Record<string, number>;
    };
    const rate = json?.rates?.[BASE_CURRENCY];
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
      console.error(`[fx] ${code}->INR ${date}: no usable rate in response`);
      return null;
    }
    return { rate, rateDate: json.date ?? date, source: "ecb" };
  } catch (err) {
    console.error(`[fx] ${code}->INR ${date} lookup failed:`, errText(err));
    return null;
  }
}

/**
 * Admin-set override, e.g. `{"USD": 86.4}` under the `fx_rates_fallback` key.
 * Lets an air-gapped or rate-limited environment stay accurate without code.
 */
async function readConfiguredRate(code: string): Promise<number | null> {
  try {
    const [row] = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, "fx_rates_fallback"))
      .limit(1);
    if (!row) return null;
    const val = row.value as Record<string, unknown> | null;
    const n = Number(val?.[code]);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
