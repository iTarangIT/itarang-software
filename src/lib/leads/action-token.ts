import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { leadActionTokens } from "@/lib/db/schema";

// E-264 — no-login magic links handed to a customer over WhatsApp so they can
// finish a step on a mobile web page. The raw token rides only in the chat
// message; only sha256(raw) is stored, so a database read alone cannot forge an
// action. That half is copied from src/lib/nbfc/act-token.ts.
//
// The other half — a consumer route that needs NO session — is copied from the
// customer upload-link flow. Neither existing system could be used directly:
// the act-token consumer page still demands an admin browser session, and the
// upload-token stores its secret in plaintext across three duplicated
// generators. This owns the token itself so any purpose can reuse it.

export const LEAD_ACTION_PURPOSES = [
  "co_borrower",
  "step4",
  "offers",
  "step5",
] as const;
export type LeadActionPurpose = (typeof LEAD_ACTION_PURPOSES)[number];

export function isLeadActionPurpose(v: string): v is LeadActionPurpose {
  return (LEAD_ACTION_PURPOSES as readonly string[]).includes(v);
}

/**
 * Three days. Long enough that a customer who reads the message the next
 * evening, or over a weekend, still gets in; short enough that a forwarded
 * screenshot stops working before the lead has moved on.
 */
export const LEAD_ACTION_TTL_MS = 72 * 60 * 60 * 1000;

export function hashLeadActionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export async function issueLeadActionToken(opts: {
  leadId: string;
  purpose: LeadActionPurpose;
  audience?: "customer" | "dealer";
  waPhone?: string | null;
  refId?: string | null;
  createdBy?: string | null;
  ttlMs?: number;
}): Promise<{ rawToken: string }> {
  const rawToken = randomBytes(32).toString("hex");
  await db.insert(leadActionTokens).values({
    lead_id: opts.leadId,
    purpose: opts.purpose,
    token_hash: hashLeadActionToken(rawToken),
    audience: opts.audience ?? "customer",
    wa_phone: opts.waPhone ?? null,
    ref_id: opts.refId ?? null,
    created_by: opts.createdBy ?? null,
    expires_at: new Date(Date.now() + (opts.ttlMs ?? LEAD_ACTION_TTL_MS)),
  });
  return { rawToken };
}

export type VerifyResult =
  | { ok: true; tokenId: string; refId: string | null }
  | { ok: false; reason: "invalid" };

/**
 * Verify a raw token against a lead and purpose.
 *
 * Every failure — unknown token, wrong lead, wrong purpose, expired, already
 * consumed — collapses into the single reason "invalid", and callers must show
 * one message for all of them. Distinguishing "expired" from "never existed"
 * tells a prober which lead ids are real; the same reasoning is written into
 * E-262 for the recovery-agent links.
 */
export async function verifyLeadActionToken(
  leadId: string,
  purpose: LeadActionPurpose,
  rawToken: string,
): Promise<VerifyResult> {
  if (!rawToken || !/^[0-9a-f]{64}$/.test(rawToken)) {
    return { ok: false, reason: "invalid" };
  }
  const [row] = await db
    .select({
      id: leadActionTokens.id,
      ref_id: leadActionTokens.ref_id,
    })
    .from(leadActionTokens)
    .where(
      and(
        eq(leadActionTokens.token_hash, hashLeadActionToken(rawToken)),
        eq(leadActionTokens.lead_id, leadId),
        eq(leadActionTokens.purpose, purpose),
        gt(leadActionTokens.expires_at, new Date()),
        isNull(leadActionTokens.consumed_at),
      ),
    )
    .limit(1);

  if (!row) return { ok: false, reason: "invalid" };
  return { ok: true, tokenId: row.id, refId: row.ref_id };
}

/** Mark a token spent. Only for purposes that are genuinely single-action. */
export async function consumeLeadActionToken(tokenId: string): Promise<void> {
  await db
    .update(leadActionTokens)
    .set({ consumed_at: new Date() })
    .where(eq(leadActionTokens.id, tokenId));
}

/**
 * Retire every live token for a lead+purpose. Called when the stage completes,
 * because a working link to a finished step is a support call.
 */
export async function revokeLeadActionTokens(
  leadId: string,
  purpose?: LeadActionPurpose,
): Promise<void> {
  await db
    .update(leadActionTokens)
    .set({ consumed_at: new Date() })
    .where(
      and(
        eq(leadActionTokens.lead_id, leadId),
        purpose ? eq(leadActionTokens.purpose, purpose) : sql`true`,
        isNull(leadActionTokens.consumed_at),
      ),
    );
}

/**
 * Absolute URL to the customer-facing page. Prefers the request host so it
 * auto-tracks localhost vs tunnel vs prod, exactly as buildActLink does.
 */
export function buildLeadActionLink(
  purpose: LeadActionPurpose,
  leadId: string,
  rawToken: string,
  req?: NextRequest | Request,
): string {
  let base = "";
  if (req) {
    const h = req.headers;
    const host = h.get("x-forwarded-host") || h.get("host") || "";
    if (host) {
      const proto =
        h.get("x-forwarded-proto") ||
        (host.startsWith("localhost") || host.startsWith("127.0.0.1")
          ? "http"
          : "https");
      base = `${proto}://${host}`;
    }
  }
  if (!base) base = (process.env.NEXT_PUBLIC_APP_URL || "").replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "Cannot build lead action link: no request host and NEXT_PUBLIC_APP_URL is unset",
    );
  }
  return `${base.replace(/\/$/, "")}/lead-action/${purpose}/${leadId}/${rawToken}`;
}
