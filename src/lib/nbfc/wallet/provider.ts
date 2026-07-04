/**
 * WalletFundsProvider — vendor-neutral funds-provider port for the NBFC prepaid
 * wallet. BRD Addendum V0.3.1 §16.4 (and §5.3 — Razorpay demoted from a lock to
 * a candidate; ports-and-adapters so the provider can be swapped without
 * rewriting wallet logic).
 *
 * The wallet LEDGER + charging engine (`@/lib/nbfc/charging`) is the system of
 * record for balances and is fully vendor-agnostic. This port is the *other*
 * half — the bit where money actually moves into the wallet:
 *
 *   1. Per-NBFC funds-collection routing — each NBFC's top-up lands in iTarang's
 *      books unambiguously tagged to that NBFC (virtual-account-style routing).
 *   2. Inflow notification (webhook) — iTarang gets a programmatic event when
 *      funds arrive, enabling auto-credit within seconds.
 *   3. Creditor-side NACH / eMandate registration & execution — iTarang as named
 *      creditor on an NBFC-funded auto-recharge mandate; mandate execution on
 *      trigger (the §16.1 auto-NACH recharge).
 *
 * NBFC-facing UI must NOT name the vendor (§3.2 / §5.4 vendor abstraction):
 * surface "iTarang Virtual Account" and "iTarang Auto-Recharge Mandate", not
 * "Razorpay". Vendor names belong only in admin / audit / raw-payload / legal.
 *
 * Provider-specific code lives in adapter modules (e.g. ./razorpay-adapter).
 * Callers resolve the active provider via `getWalletFundsProvider()` and never
 * import an adapter directly.
 */

// ─────────────────────────── Money & identity ──────────────────────────────

/**
 * Minor units (paise) — providers transact in the smallest currency unit and we
 * keep the boundary in paise to avoid float drift. The wallet LEDGER stores
 * rupees as numeric strings; convert at the adapter→ledger seam, not here.
 */
export type Paise = number;

export interface NbfcRef {
  /** Tenant the wallet belongs to — the ledger's partition key. */
  tenantId: string;
  /** Numeric NBFC id, for provider notes / correlation. */
  nbfcId: number;
  /** Display name for the provider's customer/account record (admin-only). */
  legalName?: string | null;
}

// ───────────────── 1. Per-NBFC funds-collection routing ─────────────────────

export interface CollectionAccount {
  /** Provider's account/handle id (e.g. a virtual account id). Admin/audit only. */
  providerAccountId: string;
  /** UPI VPA the NBFC can pay into, if the provider issues one. */
  upiVpa?: string | null;
  /** Bank virtual-account number + IFSC for NEFT/RTGS/IMPS top-ups, if issued. */
  accountNumber?: string | null;
  ifsc?: string | null;
  /** Provider's lifecycle status, raw (admin/audit). */
  rawStatus?: string | null;
}

// ───────────────────── 2. Inflow notification (webhook) ─────────────────────

/** Normalised, provider-agnostic inflow event the wallet credit path consumes. */
export interface InflowEvent {
  /**
   * Provider-stable idempotency key for this inflow (e.g. payment id). The
   * credit path MUST dedupe on this so a re-delivered webhook can't double-credit.
   */
  providerEventId: string;
  /** Which NBFC wallet to credit (resolved from the account/notes). */
  tenantId: string;
  nbfcId?: number | null;
  amount: Paise;
  /** Provider's own event/entity status (admin/audit). */
  rawStatus?: string | null;
  /** Untouched provider payload, for the audit log / raw-payload store. */
  raw: unknown;
}

export type WebhookVerification =
  | { ok: true; event: InflowEvent }
  | { ok: false; reason: "bad_signature" | "unrelated_event" | "parse_error"; detail?: string };

// ───────── 3. Creditor-side NACH / eMandate (auto-recharge) ──────────────────

export interface RegisterMandateArgs extends NbfcRef {
  /** Ceiling per debit. Defaults to the provider's safe max if omitted. */
  maxAmount?: Paise;
  /** iTarang correlation ref stored in provider notes for the webhook. */
  mandateRef: string;
  /**
   * Payer (NBFC) contact for the mandate. Providers commonly REQUIRE a contact
   * phone for a recurring/e-mandate link (Razorpay rejects with "contact field
   * is required for recurring links" if absent), so the caller must supply at
   * least a phone.
   */
  contactEmail?: string | null;
  contactPhone?: string | null;
}

export interface MandateRegistration {
  /**
   * Handoff for the NBFC to authorise the mandate. `redirect` → open `url`;
   * `checkout` → hand `checkout` params to the provider's client SDK. The
   * registered mandate is confirmed asynchronously via the inflow/mandate webhook.
   */
  mode: "redirect" | "checkout";
  url?: string | null;
  checkout?: Record<string, unknown> | null;
  /** Provider correlation handles to persist on `nbfc_wallets.auto_nach_mandate_ref` etc. */
  providerMandateId?: string | null;
  providerOrderId?: string | null;
  providerCustomerId?: string | null;
}

export interface ExecuteDebitArgs {
  tenantId: string;
  nbfcId?: number | null;
  /** The registered mandate ref / token to debit against. */
  providerMandateRef: string;
  amount: Paise;
  /** iTarang idempotency key — the provider must not double-debit on retry. */
  idempotencyKey: string;
  description?: string;
}

export interface ExecuteDebitResult {
  /** Provider payment/transaction id, for correlation with the inflow webhook. */
  providerPaymentId: string;
  /**
   * `submitted` — the debit was accepted by the provider but settles async; the
   * wallet credit happens when the matching InflowEvent arrives, NOT here.
   * `failed` — provider rejected it outright (e.g. mandate revoked, insufficient).
   */
  status: "submitted" | "failed";
  rawStatus?: string | null;
}

// ─────────────────────────── The port itself ───────────────────────────────

export interface WalletFundsProvider {
  /** Stable id for this adapter, recorded in audit (e.g. "razorpay"). */
  readonly providerId: string;

  /** 1 — provision (or fetch) the NBFC's funds-collection account. */
  ensureCollectionAccount(nbfc: NbfcRef): Promise<CollectionAccount>;

  /** 2 — verify + normalise an inflow webhook into an InflowEvent. */
  parseInflowWebhook(rawBody: string, headers: Record<string, string>): Promise<WebhookVerification>;

  /** 3a — register the creditor-side auto-recharge NACH/eMandate. */
  registerAutoRechargeMandate(args: RegisterMandateArgs): Promise<MandateRegistration>;

  /** 3b — execute one debit on a registered mandate (the §16.1 auto-recharge). */
  executeAutoRechargeDebit(args: ExecuteDebitArgs): Promise<ExecuteDebitResult>;
}

// ─────────────────────────── Provider registry ─────────────────────────────

/**
 * Resolves the active provider. Selected by `WALLET_FUNDS_PROVIDER` (defaults to
 * "razorpay", the v1 candidate per §5.3). Adapters are imported lazily so a
 * provider's SDK / env vars are only required when that provider is selected.
 */
export async function getWalletFundsProvider(): Promise<WalletFundsProvider> {
  const id = (process.env.WALLET_FUNDS_PROVIDER || "razorpay").toLowerCase();
  switch (id) {
    case "razorpay": {
      const { RazorpayWalletFundsProvider } = await import("./razorpay-adapter");
      return new RazorpayWalletFundsProvider();
    }
    default:
      throw new Error(`WALLET_FUNDS_PROVIDER: unknown provider '${id}'`);
  }
}
