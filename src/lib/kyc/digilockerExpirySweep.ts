// ID 201 (4 Nov leftover) — the "DigiLocker request expired" history line is
// written even if nobody opens the Aadhaar card.
//
// Until now the line came only from the status routes, which the Aadhaar card
// polls: if no Admin / Sales Head opened the card after the link ran out, the
// file's KYC history never said the request expired. This sweep (in-process,
// every 15 minutes) writes the same line for both borrowers, with the SAME
// once-keys the routes use, so whichever runs first wins and the line is never
// written twice:
//   main borrower  digilocker_transactions, link past expires_at, never
//                  fetched / failed → status 'expired' (as the status route
//                  does) + "DigiLocker (Aadhaar) request expired",
//                  once `digilocker:<id>:expired`;
//   co-borrower    kyc_verifications (co_borrower, aadhaar) whose session
//                  started more than 24 h ago with no consent, no data and no
//                  refusal (coBorrowerDigilockerExpired) →
//                  "DigiLocker (Aadhaar) request expired (co-borrower)",
//                  once `digilocker:<id>:expired:<initiated_at>`.
// Only requests started from SWEEP_FROM: older files are not back-filled with
// lines stamped today.

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { coBorrowerDigilockerExpired, coBorrowerDigilockerRefused } from "@/lib/kyc/coborrower-verification";
import { recordSystemKycStepOnce } from "@/lib/kyc/kycEventLog";

/** Requests started before this are left alone (the sweep shipped 5 Nov 2026). */
export const SWEEP_FROM = "2026-11-05T00:00:00+05:30";
const BATCH = 200;

export const MAIN_EXPIRED_STEP = "DigiLocker (Aadhaar) request expired";
export const COBORROWER_EXPIRED_STEP = "DigiLocker (Aadhaar) request expired (co-borrower)";

export const mainExpiredKey = (transactionId: string) => `digilocker:${transactionId}:expired`;
export const coBorrowerExpiredKey = (verificationId: string, initiatedAt: string) =>
  `digilocker:${verificationId}:expired:${initiatedAt}`;

/** Main-borrower statuses that a run-out link turns into 'expired'. */
export const MAIN_OPEN_STATUSES = ["initiating", "link_sent", "link_opened", "consent_given"] as const;

/**
 * Pure: has this co-borrower session run out with nothing to show for it?
 * Mirrors executeCoBorrowerDigilockerStatus: no consent, no Aadhaar data, not
 * refused, started (initiated_at) more than 24 h ago and not before SWEEP_FROM.
 */
export function coBorrowerSessionExpired(apiData: Record<string, unknown>, now: Date = new Date()): boolean {
  const initiatedAt = apiData.initiated_at;
  if (typeof initiatedAt !== "string") return false;
  if (new Date(initiatedAt).getTime() < new Date(SWEEP_FROM).getTime()) return false;
  if (typeof apiData.consent_given_at === "string") return false;
  const hasData =
    !!(apiData.aadhaarData && Object.keys(apiData.aadhaarData as Record<string, unknown>).length > 0) ||
    !!apiData.proofOfIdentity ||
    !!apiData.aadhaarUid ||
    !!apiData.name;
  if (hasData) return false;
  if (coBorrowerDigilockerRefused(apiData)) return false;
  return coBorrowerDigilockerExpired(initiatedAt, now);
}

export type ExpirySweepResult = { main: number; coBorrower: number; dryRun: boolean };

export async function runDigilockerExpirySweep(
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<ExpirySweepResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const nowIso = now.toISOString();

  // ── Main borrower ──
  const open = sql.join(MAIN_OPEN_STATUSES.map((s) => sql`${s}`), sql`, `);
  const mainRows = (await db.execute(sql`
    SELECT id, lead_id, status
      FROM digilocker_transactions
     WHERE expires_at IS NOT NULL
       AND expires_at < ${nowIso}::timestamptz
       AND created_at >= ${SWEEP_FROM}::timestamptz
       AND status IN (${open})
     ORDER BY expires_at
     LIMIT ${BATCH}
  `)) as unknown as Array<{ id: string; lead_id: string; status: string }>;

  let main = 0;
  for (const r of mainRows) {
    if (dryRun) {
      main++;
      continue;
    }
    await db.execute(sql`
      UPDATE digilocker_transactions SET status = 'expired', updated_at = now()
       WHERE id = ${r.id} AND status IN (${open})
    `);
    // Writes nothing when the status route already logged it (same key).
    await recordSystemKycStepOnce(r.lead_id, MAIN_EXPIRED_STEP, mainExpiredKey(r.id));
    main++;
  }

  // ── Co-borrower ──
  const coRows = (await db.execute(sql`
    SELECT id, lead_id, api_response->'data' AS data
      FROM kyc_verifications
     WHERE applicant = 'co_borrower'
       AND verification_type = 'aadhaar'
       AND status = 'in_progress'
       AND api_response->'data'->>'initiated_at' IS NOT NULL
       AND (api_response->'data'->>'initiated_at')::timestamptz >= ${SWEEP_FROM}::timestamptz
       AND (api_response->'data'->>'initiated_at')::timestamptz < ${nowIso}::timestamptz - interval '24 hours'
       -- A session still 'in_progress' stays so for ever; looking back 14 days
       -- bounds the scan (its line was written within a day of running out).
       AND (api_response->'data'->>'initiated_at')::timestamptz >= ${nowIso}::timestamptz - interval '14 days'
     LIMIT ${BATCH}
  `)) as unknown as Array<{ id: string; lead_id: string; data: Record<string, unknown> | null }>;

  let coBorrower = 0;
  for (const r of coRows) {
    const data = r.data ?? {};
    if (!coBorrowerSessionExpired(data, now)) continue;
    coBorrower++;
    if (dryRun) continue;
    await recordSystemKycStepOnce(
      r.lead_id,
      COBORROWER_EXPIRED_STEP,
      coBorrowerExpiredKey(r.id, data.initiated_at as string),
    );
  }

  return { main, coBorrower, dryRun };
}
