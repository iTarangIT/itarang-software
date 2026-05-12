/**
 * E-007 — server-side helpers for the NBFC LSP agreement initiate flow.
 *
 * Pure helpers (no Next.js types) to keep the route handler testable and
 * focused on HTTP concerns. The real Digio call happens in the route via
 * `createMultiTemplateSignRequest`; this module only owns:
 *   - agreement_id generation (AGR-NBFC-YYYYMMDD-SEQ pattern, daily reset)
 *   - signer order assembly (NBFC → iTarang1 → iTarang2)
 *   - expire_in_days resolution from server config
 *   - status guard against the NBFC's current lifecycle stage
 */
import { sql } from "drizzle-orm";
import { db as defaultDb } from "@/lib/db";
import { nbfcLspAgreements } from "@/lib/db/schema";
import type { MultiTemplateSigner } from "@/lib/digio/multi-templates";

type DrizzleDb = typeof defaultDb;

export const AGREEMENT_INITIATE_ALLOWED_NBFC_STATUSES = new Set([
  "draft",
  "pending_review",
  "pending_admin_review",
  "request_correction",
]);

/** Resolve expire_in_days from server settings. Server-trusted; never reads
 * the client body for this value. Defaults to BRD-mandated 5. */
export function resolveLspExpireInDays(): number {
  const raw = process.env.NBFC_LSP_EXPIRE_IN_DAYS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0 && n <= 365) return n;
  }
  return 5;
}

/** Format YYYYMMDD in UTC (daily seq resets at UTC midnight; cheap and
 * timezone-stable). */
export function formatYyyymmddUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/**
 * Build the signer array in the BRD-mandated order.
 * Index 0 signs first when sequential=true: NBFC → iTarang1 → iTarang2.
 */
export function buildSignerOrder(input: {
  nbfcSignatoryName: string;
  nbfcSignatoryEmail: string;
  itarangSignatory1Name: string;
  itarangSignatory1Email: string;
  itarangSignatory2Name: string;
  itarangSignatory2Email: string;
}): MultiTemplateSigner[] {
  return [
    {
      identifier: input.nbfcSignatoryEmail,
      name: input.nbfcSignatoryName,
      reason: "NBFC Signatory",
    },
    {
      identifier: input.itarangSignatory1Email,
      name: input.itarangSignatory1Name,
      reason: "iTarang Signatory 1",
    },
    {
      identifier: input.itarangSignatory2Email,
      name: input.itarangSignatory2Name,
      reason: "iTarang Signatory 2",
    },
  ];
}

/**
 * Generate the next agreement_id for today as `AGR-NBFC-YYYYMMDD-NNNN`.
 *
 * Uses a row-count over today's existing agreement_ids inside a transaction-
 * adjacent SELECT. Collisions are eliminated downstream by the unique index
 * on `agreement_id` — on a clash the caller should retry once. This is
 * deliberately a daily count (cheap and good enough for human-readable IDs);
 * a true daily sequence table is overkill for the BRD's audit requirement.
 */
export async function generateAgreementId(
  database: DrizzleDb,
  today: Date = new Date(),
): Promise<string> {
  const datePart = formatYyyymmddUtc(today);
  const prefix = `AGR-NBFC-${datePart}-`;
  const rows = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(nbfcLspAgreements)
    .where(sql`${nbfcLspAgreements.agreement_id} like ${prefix + "%"}`);
  const count = Number(rows[0]?.count ?? 0);
  const seq = String(count + 1).padStart(4, "0");
  return `${prefix}${seq}`;
}
