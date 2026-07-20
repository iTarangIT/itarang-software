/**
 * Razorpay adapter for the WalletFundsProvider port — BRD Addendum V0.3.1 §16.4,
 * Razorpay (Smart Collect + NACH) the §5.3 v1 candidate (NOT a BRD lock).
 *
 * Mapping of the three §16.4 capabilities onto Razorpay products:
 *   1. Per-NBFC funds-collection routing → Smart Collect virtual accounts
 *      (one VA per NBFC; the VA's notes carry tenant/nbfc for unambiguous tagging).
 *   2. Inflow notification → Razorpay `virtual_account.credited` /
 *      `payment.captured` webhook, signature-verified.
 *   3. Creditor-side auto-recharge mandate → Razorpay e-mandate (Orders + Tokens),
 *      same product the borrower E-NACH path already uses (see @/lib/razorpay).
 *
 * Reuse, don't fork: signature verification, error unwrapping and the e-mandate /
 * Smart Collect / recurring helpers all live in `@/lib/razorpay`. Callers reach
 * this adapter only via `getWalletFundsProvider()`, never Razorpay directly.
 */
import {
  verifyWebhookSignature,
  razorpayErrorMessage,
  createVirtualAccount,
  fetchVirtualAccount,
  createEmandateCustomer,
  createEmandateOrder,
  createRecurringDebit,
} from "@/lib/razorpay";
import type {
  WalletFundsProvider,
  NbfcRef,
  CollectionAccount,
  WebhookVerification,
  InflowEvent,
  RegisterMandateArgs,
  MandateRegistration,
  ExecuteDebitArgs,
  ExecuteDebitResult,
} from "./provider";

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const asStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const asInt = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export class RazorpayWalletFundsProvider implements WalletFundsProvider {
  readonly providerId = "razorpay";

  /**
   * 1 — Provision a Smart Collect virtual account for the NBFC. The VA's notes
   * carry { itarang_tenant_id, itarang_nbfc_id } so an inflow can be routed back
   * to the right wallet. Surfaced as the "iTarang Virtual Account" (§3.2).
   */
  async ensureCollectionAccount(nbfc: NbfcRef): Promise<CollectionAccount> {
    try {
      const va = await createVirtualAccount({
        tenantId: nbfc.tenantId,
        nbfcId: nbfc.nbfcId,
        name: nbfc.legalName || `NBFC ${nbfc.nbfcId}`,
      });
      return {
        providerAccountId: va.id,
        upiVpa: va.upiVpa,
        accountNumber: va.accountNumber,
        ifsc: va.ifsc,
        rawStatus: va.status,
      };
    } catch (e) {
      // Vendor SDK rejects with a plain object, not an Error — unwrap it to a
      // readable message for the SERVER LOG only. The NBFC-facing message stays
      // vendor-neutral (§3.2): never leak the vendor's name/detail to the UI.
      // PROVIDER_ERROR is a safe prefix, so this reaches the NBFC as-is (and is
      // NOT re-masked by clientError) — hence we log the real cause here.
      console.error("[wallet-provider:razorpay] ensureCollectionAccount failed:", razorpayErrorMessage(e));
      throw new Error(
        "PROVIDER_ERROR: Couldn't issue the iTarang Virtual Account right now. " +
          "Please retry in a moment; if it keeps failing, contact iTarang support.",
      );
    }
  }

  /**
   * 2 — Verify the webhook signature with RAZORPAY_WEBHOOK_SECRET, then map a
   * `virtual_account.credited` / `payment.captured` event to an InflowEvent.
   * Resolve tenant/nbfc from the VA / payment notes. `providerEventId` = payment
   * id so the credit path can dedupe a re-delivered webhook. Returns `ok:false`
   * (not a throw) for an unrelated event or a bad signature.
   */
  async parseInflowWebhook(
    rawBody: string,
    headers: Record<string, string>,
  ): Promise<WebhookVerification> {
    const signature = headers["x-razorpay-signature"] ?? headers["X-Razorpay-Signature"];
    if (!signature) return { ok: false, reason: "bad_signature", detail: "missing signature header" };
    try {
      if (!verifyWebhookSignature(rawBody, signature)) {
        return { ok: false, reason: "bad_signature" };
      }
    } catch (e) {
      return { ok: false, reason: "parse_error", detail: razorpayErrorMessage(e) };
    }

    let event: Json;
    try {
      event = JSON.parse(rawBody) as Json;
    } catch (e) {
      return { ok: false, reason: "parse_error", detail: razorpayErrorMessage(e) };
    }

    const eventName = asStr(event.event) ?? "";
    if (eventName !== "virtual_account.credited" && eventName !== "payment.captured") {
      return { ok: false, reason: "unrelated_event", detail: eventName };
    }

    const payload = asObj(event.payload);
    const paymentEntity = asObj(asObj(payload.payment).entity);
    const vaEntity = asObj(asObj(payload.virtual_account).entity);

    // Notes carrying our routing live on the VA (Smart Collect) and/or the
    // payment. Merge both; the VA's notes are the authoritative routing key.
    const notes = { ...asObj(paymentEntity.notes), ...asObj(vaEntity.notes) };
    const tenantId = asStr(notes.itarang_tenant_id);
    const nbfcId = asInt(notes.itarang_nbfc_id);

    // providerEventId must be stable per inflow — the captured payment id.
    const providerEventId = asStr(paymentEntity.id) ?? asStr(vaEntity.id);
    const amount = asInt(paymentEntity.amount); // paise

    if (!tenantId || !providerEventId || amount == null || amount <= 0) {
      return {
        ok: false,
        reason: "unrelated_event",
        detail: "inflow missing tenant note / payment id / amount",
      };
    }

    const inflow: InflowEvent = {
      providerEventId,
      tenantId,
      nbfcId,
      amount,
      rawStatus: asStr(paymentEntity.status) ?? eventName,
      raw: event,
    };
    return { ok: true, event: inflow };
  }

  /**
   * 3a — Register the creditor-side auto-recharge e-mandate (iTarang as named
   * creditor). Reuses the borrower E-NACH managed helpers; the payer is the NBFC.
   * Returns the Checkout handoff + the order/customer ids to persist on the
   * wallet. Surface as "iTarang Auto-Recharge Mandate" in NBFC UI (§3.2).
   */
  async registerAutoRechargeMandate(args: RegisterMandateArgs): Promise<MandateRegistration> {
    try {
      const customer = await createEmandateCustomer({
        name: args.legalName || `NBFC ${args.nbfcId}`,
        email: args.contactEmail || undefined,
        contact: args.contactPhone || undefined,
        notes: {
          itarang_tenant_id: args.tenantId,
          itarang_nbfc_id: String(args.nbfcId),
          itarang_purpose: "wallet_auto_recharge",
          itarang_mandate_ref: args.mandateRef,
        },
      });
      const order = await createEmandateOrder({
        customerId: customer.id,
        maxAmountPaise: args.maxAmount,
        authType: "netbanking",
        enachRef: args.mandateRef,
        leadId: args.mandateRef, // no lead — the mandate ref doubles as the receipt/correlation
        nbfcId: args.nbfcId,
      });
      return {
        mode: "checkout",
        checkout: {
          order_id: order.order_id,
          key_id: order.key_id,
          customer_id: order.customer_id,
          amount: order.amount,
          currency: order.currency,
        },
        providerOrderId: order.order_id,
        providerCustomerId: order.customer_id,
      };
    } catch (e) {
      // Real vendor cause → server log only; NBFC sees a vendor-neutral message
      // (§3.2). See ensureCollectionAccount for the PROVIDER_ERROR rationale.
      console.error("[wallet-provider:razorpay] registerAutoRechargeMandate failed:", razorpayErrorMessage(e));
      throw new Error(
        "PROVIDER_ERROR: Couldn't start the auto-recharge mandate right now. " +
          "Please retry in a moment; if it keeps failing, contact iTarang support.",
      );
    }
  }

  /**
   * 3b — Execute one debit against the registered mandate token. Called by the
   * cron auto-NACH recharge when balance < threshold. The wallet is credited only
   * when the resulting InflowEvent arrives — NOT synchronously here — so the
   * return is `submitted`, idempotent on the idempotencyKey.
   */
  async executeAutoRechargeDebit(args: ExecuteDebitArgs): Promise<ExecuteDebitResult> {
    try {
      const res = await createRecurringDebit({
        customerId: args.providerMandateRef.split("|")[0] || "",
        tokenId: args.providerMandateRef.split("|")[1] || args.providerMandateRef,
        amountPaise: args.amount,
        idempotencyKey: args.idempotencyKey,
        notes: {
          itarang_tenant_id: args.tenantId,
          itarang_nbfc_id: args.nbfcId != null ? String(args.nbfcId) : "",
          itarang_purpose: "wallet_auto_recharge",
        },
      });
      const failed = /fail|error/i.test(res.status);
      return {
        providerPaymentId: res.paymentId,
        status: failed ? "failed" : "submitted",
        rawStatus: res.status,
      };
    } catch (e) {
      return { providerPaymentId: "", status: "failed", rawStatus: razorpayErrorMessage(e) };
    }
  }
}
