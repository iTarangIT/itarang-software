/**
 * E-243 — the signed link a dealer uses to answer a quotation.
 *
 * ## Why a signed token and not a database row
 *
 * The obvious shape is a `quotation_approval_tokens` table: mint a row on send,
 * mark it used on click, expire the rest. That table would need writing on every
 * send, cleaning when a quotation is never answered, and a second write on every
 * decision — three moving parts to answer one question the quotation itself can
 * already answer.
 *
 * An HMAC over (commercial_id, version_no) is verifiable with no storage at all.
 * SINGLE USE IS ENFORCED BY THE DECISION, not by the token: recordDealerDecision
 * writes only `WHERE dealer_decision IS NULL`, so a forwarded email or a
 * re-tapped link finds the answer already recorded and changes nothing. That is
 * a stronger guarantee than marking a token used, because it also covers two
 * different tokens for the same quotation.
 *
 * ## Why version_no is inside the signature
 *
 * A revision is a NEW commercials row with its own id, so a token for v2 cannot
 * open v3. Including the version anyway means a token is bound to the exact
 * document the dealer was shown, and a mismatch — which should be impossible —
 * fails closed rather than silently answering a different quotation.
 *
 * ## The secret
 *
 * QUOTE_TOKEN_SECRET, falling back to SUPABASE_SERVICE_ROLE_KEY and then
 * NEXTAUTH_SECRET so a deployment that has not set the dedicated variable still
 * gets a real per-environment secret rather than a constant baked into the
 * repo. There is no hardcoded default: if none of them is set, minting throws,
 * because a token signed with a public string is not a token.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Kept short — it rides in a URL and in a WhatsApp caption. */
const SIG_LENGTH = 32;

export class QuoteTokenSecretMissingError extends Error {
  constructor() {
    super(
      "No signing secret for quotation approval links. Set QUOTE_TOKEN_SECRET.",
    );
  }
}

function secret(): string {
  const s =
    process.env.QUOTE_TOKEN_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.NEXTAUTH_SECRET;
  // No fallback constant on purpose. A predictable secret would let anyone mint
  // a link that approves any quotation, and failing loudly at send time is far
  // better than shipping links that look signed and are not.
  if (!s) throw new QuoteTokenSecretMissingError();
  return s;
}

function sign(payload: string): string {
  return createHmac("sha256", secret())
    .update(payload, "utf8")
    .digest("hex")
    .slice(0, SIG_LENGTH);
}

/**
 * Base64url so the token survives a URL, a WhatsApp caption and an email client
 * that helpfully "fixes" punctuation.
 */
function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function unb64url(s: string): string | null {
  try {
    return Buffer.from(s, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export interface QuoteTokenClaims {
  commercialId: string;
  versionNo: number;
}

/** `<base64url(commercialId.versionNo)>.<sig>` */
export function mintQuoteToken(claims: QuoteTokenClaims): string {
  const payload = `${claims.commercialId}.${claims.versionNo}`;
  return `${b64url(payload)}.${sign(payload)}`;
}

/**
 * Verify and decode. Returns null for anything that is not a token this server
 * minted — malformed, tampered, or signed with a different secret.
 *
 * Constant-time comparison: the signature is the only thing standing between a
 * stranger and approving somebody else's quotation, so it is not compared with
 * `===`.
 */
export function readQuoteToken(token: string | null | undefined): QuoteTokenClaims | null {
  if (!token || typeof token !== "string") return null;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const encoded = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const payload = unb64url(encoded);
  if (!payload) return null;

  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    // Secret missing — refuse every token rather than accepting any.
    return null;
  }

  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const sep = payload.lastIndexOf(".");
  if (sep <= 0) return null;
  const commercialId = payload.slice(0, sep);
  const versionNo = Number(payload.slice(sep + 1));
  if (!commercialId || !Number.isInteger(versionNo)) return null;

  return { commercialId, versionNo };
}

/**
 * The absolute URL a dealer opens.
 *
 * Absolute because it goes into an email and a WhatsApp message, where a
 * relative path is meaningless.
 */
export function quoteApprovalUrl(claims: QuoteTokenClaims): string {
  const base = (
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    "https://crm.itarang.com"
  ).replace(/\/+$/, "");
  return `${base}/quote/${mintQuoteToken(claims)}`;
}
