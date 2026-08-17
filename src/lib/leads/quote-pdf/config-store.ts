/**
 * The app_settings half of the quotation document config.
 *
 * Split from ./config so the defaults and the merge stay importable without a
 * DATABASE_URL — the same reason src/lib/telemetry/thresholds-math.ts is split
 * from thresholds.ts. Everything pure is re-exported here, so a caller that
 * wants both needs only this module.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { appSettings } from "@/lib/db/schema";
import {
  DEFAULT_QUOTATION_CONFIG,
  mergeQuotationConfig,
  QUOTATION_SETTINGS_KEY,
  type QuotationDocConfig,
} from "./config";

export {
  DEFAULT_QUOTATION_CONFIG,
  mergeQuotationConfig,
  QUOTATION_SETTINGS_KEY,
  stateCodeFromGstin,
  type QuotationDocConfig,
} from "./config";

/**
 * The config in force, from app_settings if a row exists.
 *
 * Never throws: a failed read yields the defaults. This runs downstream of an
 * approval that has already committed, so a missing or malformed settings row
 * must degrade to the document the business signed off rather than block a
 * quotation from existing at all.
 *
 * The document carries no bundled images. A logo or a signature is possible —
 * both are fields on the config — but only by putting a data: URI in the
 * app_settings row, never by dropping a file in the repo. See the note on
 * SellerBlock.logoDataUri for why nothing else works under this renderer.
 */
export async function resolveQuotationConfig(): Promise<QuotationDocConfig> {
  try {
    const [row] = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, QUOTATION_SETTINGS_KEY))
      .limit(1);
    return mergeQuotationConfig(row?.value);
  } catch (e) {
    console.error("[quote-pdf/config-store] falling back to defaults", e);
    return DEFAULT_QUOTATION_CONFIG;
  }
}
