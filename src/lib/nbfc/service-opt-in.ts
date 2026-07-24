/**
 * Effective Service Opt-In for a lead — which verification steps actually run
 * through iTarang right now.
 *
 * Two sources exist:
 *
 *   • the LIVE per-tenant row in `nbfc_service_config` (Settings → Service
 *     Opt-In), and
 *   • the per-lead `service_config_snapshot` frozen when the lead bound to the
 *     NBFC (E-133).
 *
 * For the four MASTER TOGGLES — FI, Video KYC, E-NACH and whether the loan
 * agreement runs here at all — the LIVE row wins. Switching a service off in
 * Settings takes that step out of every lead immediately (it shows as "Skipped"
 * and locked in Acquire), and switching it back on restores it. That is a
 * deliberate departure from Addendum V0.3.1 §7.4's "new leads only" freeze,
 * which left in-flight leads showing steps the NBFC had already opted out of.
 *
 * The snapshot still governs everything else — vkyc_mode, enach_handoff_method,
 * storage opt-in, the two Track Rules — so an in-flight lead keeps running on
 * the mechanics it started with. The snapshot is also the fallback for the
 * toggles themselves when the tenant has no live row at all.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcServiceConfig } from "@/lib/db/schema";
import type { AgreementMethod } from "@/lib/nbfc/agreement";

export interface ServiceOptIn {
  fi_enabled: boolean;
  vkyc_enabled: boolean;
  enach_enabled: boolean;
  /** null ⇒ "Not through iTarang" — no agreement rail for this lead. */
  doc_agreement_method: AgreementMethod | null;
  /** True when the flags came from the live row rather than the snapshot. */
  from_live: boolean;
}

type Snap = {
  fi_enabled?: boolean;
  vkyc_enabled?: boolean;
  enach_enabled?: boolean;
  doc_agreement_method?: AgreementMethod | string | null;
};

/**
 * Resolves the effective opt-in toggles for a tenant. Pass the lead's
 * `service_config_snapshot` so a tenant with no live row (never opened
 * Settings) still behaves as it did when the lead bound.
 */
export async function resolveServiceOptIn(
  tenantId: string,
  snapshot?: unknown,
): Promise<ServiceOptIn> {
  const [live] = await db
    .select({
      fi: nbfcServiceConfig.fi_enabled,
      vkyc: nbfcServiceConfig.vkyc_enabled,
      enach: nbfcServiceConfig.enach_enabled,
      method: nbfcServiceConfig.doc_agreement_method,
    })
    .from(nbfcServiceConfig)
    .where(eq(nbfcServiceConfig.tenant_id, tenantId))
    .limit(1);

  if (live) {
    return {
      fi_enabled: live.fi ?? false,
      vkyc_enabled: live.vkyc ?? false,
      enach_enabled: live.enach ?? false,
      doc_agreement_method: (live.method ?? null) as AgreementMethod | null,
      from_live: true,
    };
  }

  const snap = (snapshot ?? {}) as Snap;
  return {
    fi_enabled: snap.fi_enabled ?? false,
    vkyc_enabled: snap.vkyc_enabled ?? false,
    enach_enabled: snap.enach_enabled ?? false,
    doc_agreement_method: (snap.doc_agreement_method ??
      null) as AgreementMethod | null,
    from_live: false,
  };
}
