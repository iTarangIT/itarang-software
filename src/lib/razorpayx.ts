// RazorpayX — dealer payouts (E-193/R2). The `razorpay` npm SDK has NO
// RazorpayX support (verified against the SDK + docs, 2026-07), so this is a
// raw `fetch`-based client, mirroring src/lib/razorpay.ts's conventions: lazy
// env reads (nothing is read at module load), and an `*ErrorMessage` helper
// that unwraps a provider rejection into a human string.
//
// Peer of src/lib/razorpay.ts. No buyback imports, no db imports — this file
// is a pure provider client. Dead code until a later task wires it into the
// buyback payout route; `payoutsConfigured()` lets callers no-op cleanly while
// the three RAZORPAYX_* env vars are unset.

const RAZORPAYX_BASE_URL = "https://api.razorpay.com/v1";

function envKeyId(): string {
  return process.env.RAZORPAYX_KEY_ID || "";
}
function envKeySecret(): string {
  return process.env.RAZORPAYX_KEY_SECRET || "";
}
function envAccountNumber(): string {
  return process.env.RAZORPAYX_ACCOUNT_NUMBER || "";
}

/** True only when all three RazorpayX env vars are non-empty. */
export function payoutsConfigured(): boolean {
  return Boolean(envKeyId() && envKeySecret() && envAccountNumber());
}

function authHeader(): string {
  // Never log this — it is derived from the key secret.
  return "Basic " + Buffer.from(`${envKeyId()}:${envKeySecret()}`).toString("base64");
}

export interface CompositePayoutParams {
  amountPaise: number; // integer paise, min 100
  beneficiary: { name: string; ifsc: string; accountNumber: string };
  contact: { name: string; email?: string | null; phone?: string | null };
  referenceId: string; // gateway txn UUID (<= 40 chars)
  narration?: string; // <= 30 chars, alphanumeric + space only
  notes: Record<string, string>; // <= 15 pairs
  idempotencyKey: string; // gateway txn UUID
}

export interface RazorpayxPayout {
  id: string; // 'pout_...'
  status: string; // queued|pending|processing|processed|reversed|cancelled|rejected|failed
  utr: string | null;
  amountPaise: number;
  failureReason: string | null;
  raw: unknown;
}

interface RazorpayxPayoutEntity {
  id: string;
  status: string;
  utr?: string | null;
  amount: number;
  failure_reason?: string | null;
}

interface RazorpayxErrorResponse {
  error?: { code?: string; description?: string };
}

/** IMPS up to (and including) ₹5,00,000; NEFT above — RazorpayX's own ceiling
 *  for the faster rail. */
function payoutMode(amountPaise: number): "IMPS" | "NEFT" {
  return amountPaise <= 5_00_000_00 ? "IMPS" : "NEFT";
}

/** Alphanumeric + space only, truncated to 30 chars — RazorpayX's narration rules. */
function sanitizeNarration(narration?: string): string | undefined {
  if (!narration) return undefined;
  const cleaned = narration.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 30);
  return cleaned || undefined;
}

function mapPayout(entity: RazorpayxPayoutEntity): RazorpayxPayout {
  // A 2xx with a non-JSON/empty body parses to {} upstream — fail loud rather
  // than persist a blank attempt with undefined id/status/amount.
  if (!entity?.id) {
    throw new Error("RazorpayX: malformed 2xx response (no payout id)");
  }
  return {
    id: entity.id,
    status: entity.status,
    utr: entity.utr ?? null,
    amountPaise: entity.amount,
    failureReason: entity.failure_reason ?? null,
    raw: entity,
  };
}

async function razorpayxRequest<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: Record<string, unknown>; idempotencyKey?: string },
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: authHeader(),
    "Content-Type": "application/json",
  };
  if (init.idempotencyKey) {
    headers["X-Payout-Idempotency"] = init.idempotencyKey;
  }
  const res = await fetch(`${RAZORPAYX_BASE_URL}${path}`, {
    method: init.method,
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as RazorpayxErrorResponse & Record<string, unknown>;
  if (!res.ok) {
    const description = json?.error?.description || `RazorpayX request failed (HTTP ${res.status})`;
    throw new Error(description);
  }
  return json as T;
}

export async function createCompositePayout(p: CompositePayoutParams): Promise<RazorpayxPayout> {
  const contact: Record<string, unknown> = {
    name: p.contact.name,
    type: "vendor",
  };
  if (p.contact.email) contact.email = p.contact.email;
  if (p.contact.phone) contact.contact = p.contact.phone;

  const body: Record<string, unknown> = {
    account_number: envAccountNumber(),
    amount: p.amountPaise,
    currency: "INR",
    mode: payoutMode(p.amountPaise),
    purpose: "vendor bill",
    fund_account: {
      account_type: "bank_account",
      bank_account: {
        name: p.beneficiary.name,
        ifsc: p.beneficiary.ifsc,
        account_number: p.beneficiary.accountNumber,
      },
      contact,
    },
    queue_if_low_balance: true,
    reference_id: p.referenceId,
    notes: p.notes,
  };
  const narration = sanitizeNarration(p.narration);
  if (narration) body.narration = narration;

  const entity = await razorpayxRequest<RazorpayxPayoutEntity>("/payouts", {
    method: "POST",
    body,
    idempotencyKey: p.idempotencyKey,
  });
  return mapPayout(entity);
}

export async function fetchPayout(payoutId: string): Promise<RazorpayxPayout> {
  const entity = await razorpayxRequest<RazorpayxPayoutEntity>(`/payouts/${payoutId}`, {
    method: "GET",
  });
  return mapPayout(entity);
}

export async function findPayoutByReference(referenceId: string): Promise<RazorpayxPayout | null> {
  const qs = new URLSearchParams({
    account_number: envAccountNumber(),
    reference_id: referenceId,
  });
  const res = await razorpayxRequest<{ items?: RazorpayxPayoutEntity[] }>(`/payouts?${qs.toString()}`, {
    method: "GET",
  });
  const first = res.items?.[0];
  return first ? mapPayout(first) : null;
}

/**
 * Unwraps a RazorpayX rejection into a human-readable string. `razorpayxRequest`
 * already throws a plain Error carrying the provider's `error.description` on a
 * non-2xx response, so this mostly hits the `.message` branch below — but also
 * handles the raw `{ error: { description } }` provider shape directly, and any
 * other unknown value, the same way src/lib/razorpay.ts's `razorpayErrorMessage`
 * does.
 */
export function razorpayxErrorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { error?: { description?: string; code?: string }; message?: string };
    if (e.error?.description) return e.error.description;
    if (e.message) return e.message;
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return err instanceof Error ? err.message : String(err);
}
