/**
 * Pile B items 9–10 — which notification types ALSO reach the lead's dealer on
 * WhatsApp, and what that message says.
 *
 * `emit()` consults this after writing the bell rows: when an event's type is
 * here, it carries a `leadId`, and one of its recipients is the lead's dealer,
 * the dealer's chat gets the message below via `pushToLead` (dealer-first
 * routing; outside the 24h window the `lead_action` doorbell template rings and
 * the prompt is parked).
 *
 * WHAT IS DELIBERATELY NOT HERE — types whose flow already pushes to WhatsApp
 * directly. Mapping them too would send the dealer the same news twice:
 *
 *   loan.offer_submitted / loan.offer_fixed   → offer route, pushOfferToWhatsApp
 *   loan.sanctioned / loan.disbursed          → sanction route, pushSanctionedToWhatsApp
 *                                               (and the NBFC sanction route emits
 *                                               loan.disbursed AT SANCTION TIME);
 *                                               the dispatch-time payment prompt is
 *                                               pushed by confirm-dispatch itself
 *   loan.rejected_by_nbfc                     → rejection-forward, pushRejectionToWhatsApp
 *   nbfc.request_forwarded / nbfc_verdict_forwarded
 *                                             → doc-requests forward, pushDocRequestToWhatsApp
 *                                               / pushExtraDocsRequest
 *   lead.recalled / lead.resubmitted          → recall routes, pushRecallToWhatsApp
 *
 * And NBFC-raised doc requests, doc verdicts and rejections never go to the
 * dealer at all — the admin is the single gate; only the forwarded versions
 * (above) reach them.
 *
 * PURE — no db, no adapter. Unit-tested in __tests__/whatsapp-dealer.test.ts.
 */

export interface DealerWaContext {
  /** Who the chat belongs to — the dealer's own name when known. */
  greetName: string;
  customerName: string;
  referenceId: string;
  /** The event's `data` payload (outcome, reason, signer…). */
  data?: Record<string, unknown> | null;
}

export interface DealerWaMessage {
  /** Free-form body sent inside the service window. */
  body: string;
  /** Third param of the `lead_action` template — one short line. */
  whatIsNeeded: string;
}

type Builder = (ctx: DealerWaContext) => DealerWaMessage;

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function reasonLine(ctx: DealerWaContext): string {
  const r = str(ctx.data?.reason) ?? str(ctx.data?.notes);
  return r ? `\nReason: ${r}` : "";
}

function head(emoji: string, title: string, ctx: DealerWaContext): string {
  return `${emoji} *${title}*\n\nCustomer: ${ctx.customerName} · ${ctx.referenceId}`;
}

export const WHATSAPP_DEALER_TYPES: Record<string, Builder> = {
  // --- Field investigation ---
  "fi.assigned": (ctx) => {
    const agent = str(ctx.data?.agent_name);
    return {
      body:
        head("🧭", "Field visit scheduled", ctx) +
        `\n\nThe lender has assigned a field investigation${agent ? ` to ${agent}` : ""}. ` +
        "Please make sure your customer is available at the address on file.",
      whatIsNeeded: `a field visit is scheduled for ${ctx.customerName}`,
    };
  },
  // B14 — the visit happened. Before this the dealer heard "scheduled" and
  // then "passed / failed" with nothing in between, which for a visit that
  // takes days to review reads as silence.
  "fi.submitted": (ctx) => {
    const agent = str(ctx.data?.agent_name);
    return {
      body:
        head("📋", "Field visit completed", ctx) +
        `\n\nThe field agent${agent ? ` (${agent})` : ""} has completed the visit and submitted the report. ` +
        "The lender is reviewing it — you will hear the outcome here.",
      whatIsNeeded: `the field visit for ${ctx.customerName} is done and under review`,
    };
  },
  "fi.reviewed": (ctx) => {
    const outcome = (str(ctx.data?.outcome) ?? "").toLowerCase();
    const failed = outcome.startsWith("fail");
    return failed
      ? {
          body:
            head("❌", "Field investigation failed", ctx) +
            reasonLine(ctx) +
            "\n\nThe lender did not pass the field visit. iTarang will guide the next step.",
          whatIsNeeded: `the field investigation for ${ctx.customerName} failed`,
        }
      : {
          body:
            head("✅", "Field investigation passed", ctx) +
            "\n\nThe lender has cleared the field visit. No action needed from you.",
          whatIsNeeded: `the field investigation for ${ctx.customerName} passed`,
        };
  },
  "fi.reinspection": (ctx) => ({
    body:
      head("🔁", "Re-inspection ordered", ctx) +
      reasonLine(ctx) +
      "\n\nThe lender wants another field visit. Please make sure your customer is available again.",
    whatIsNeeded: `a re-inspection was ordered for ${ctx.customerName}`,
  }),

  // --- Video KYC ---
  "vkyc.initiated": (ctx) => ({
    body:
      head("🎥", "Video KYC link sent", ctx) +
      "\n\nThe lender sent a Video KYC link to your customer. Please ask them to complete it soon.",
    whatIsNeeded: `${ctx.customerName} needs to complete Video KYC`,
  }),
  "vkyc.approved": (ctx) => ({
    body: head("✅", "Video KYC approved", ctx) + "\n\nNo action needed from you.",
    whatIsNeeded: `Video KYC for ${ctx.customerName} was approved`,
  }),
  "vkyc.rejected": (ctx) => ({
    body:
      head("❌", "Video KYC rejected", ctx) +
      reasonLine(ctx) +
      "\n\nThe lender may ask your customer to redo it.",
    whatIsNeeded: `Video KYC for ${ctx.customerName} was rejected`,
  }),

  // --- E-NACH ---
  "enach.confirmed": (ctx) => ({
    body: head("🏦", "E-NACH mandate active", ctx) + "\n\nThe auto-debit mandate is registered.",
    whatIsNeeded: `the E-NACH mandate for ${ctx.customerName} is active`,
  }),
  "enach.failed": (ctx) => ({
    body:
      head("⚠️", "E-NACH mandate failed", ctx) +
      reasonLine(ctx) +
      "\n\nPlease help your customer retry the mandate registration.",
    whatIsNeeded: `the E-NACH mandate for ${ctx.customerName} failed`,
  }),
  "enach.waived": (ctx) => ({
    body: head("ℹ️", "E-NACH not required", ctx) + "\n\nThe lender waived the E-NACH mandate for this loan.",
    whatIsNeeded: `E-NACH was waived for ${ctx.customerName}`,
  }),

  // --- Loan agreement ---
  "agreement.initiated": (ctx) => {
    const signer = str(ctx.data?.signer);
    return {
      body:
        head("✍️", "Loan agreement sent for signing", ctx) +
        `\n\nThe loan agreement was sent${signer ? ` to ${signer}` : ""}. Please ask your customer to sign it.`,
      whatIsNeeded: `${ctx.customerName} needs to sign the loan agreement`,
    };
  },
  "agreement.signed": (ctx) => {
    const pending = str(ctx.data?.pending_signer);
    return {
      body:
        head("✅", "Loan agreement signed", ctx) +
        (pending ? `\n\nStill waiting on: ${pending}.` : "\n\nAll signatures are in."),
      whatIsNeeded: `the loan agreement for ${ctx.customerName} was signed`,
    };
  },
};

/** Types whose flows push to WhatsApp themselves — asserted absent from the map. */
export const DIRECT_PUSH_TYPES: readonly string[] = [
  "loan.offer_submitted",
  "loan.offer_fixed",
  "loan.sanctioned",
  "loan.disbursed",
  "loan.rejected_by_nbfc",
  "nbfc.request_forwarded",
  "nbfc_verdict_forwarded",
  "lead.recalled",
  "lead.resubmitted",
  // Admin is the single gate — NBFC-raised asks/verdicts never reach the dealer.
  "nbfc.request_raised",
  "nbfc.doc_verified",
  "nbfc.doc_rejected",
  "nbfc.verdict_raised",
  "nbfc.application_rejected",
];

export function isDealerWhatsAppType(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(WHATSAPP_DEALER_TYPES, type);
}

/** The message for `type`, or null when the type does not go to WhatsApp. */
export function buildDealerWhatsAppMessage(
  type: string,
  ctx: DealerWaContext,
): DealerWaMessage | null {
  const builder = isDealerWhatsAppType(type) ? WHATSAPP_DEALER_TYPES[type] : null;
  return builder ? builder(ctx) : null;
}

/**
 * Dedupe key for one push: type + lead + the entity/outcome the event is about.
 * Two emits of the same fact (a retried callback, a double-click) collapse;
 * a genuinely new outcome (FI passed after a re-inspection failed) does not.
 */
export function dealerWhatsAppDedupeKey(
  type: string,
  leadId: string,
  data?: Record<string, unknown> | null,
): string {
  const entity =
    str(data?.entityId) ??
    str(data?.outcome) ??
    str(data?.reason) ??
    str(data?.signer) ??
    str(data?.pending_signer) ??
    "";
  return `${type}|${leadId}|${entity}`;
}
