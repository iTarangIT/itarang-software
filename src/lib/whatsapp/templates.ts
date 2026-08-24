/**
 * E-264 — the Meta template catalogue for the customer journey.
 *
 * WHY THIS LIVES IN CODE AND NOT IN ENV.
 *
 * Every existing WhatsApp sender in this repo reads its template name from an
 * environment variable and falls back to a free-form send when the variable is
 * unset — operator-handoff, the calculator OTP, the auction notifier. That
 * pattern grew from modelling a template name as a SECRET. It isn't one. It is a
 * contract with Meta: a fixed body, a fixed parameter count, a fixed order. Put
 * it next to the code that has to satisfy it, and the "if the env var is set"
 * branch disappears along with the class of bug where the name is configured and
 * the parameters are not.
 *
 * WHY THERE ARE ONLY FOUR.
 *
 * A template cannot carry a list, cannot carry more than three buttons, and
 * rejects newlines in body parameters. So a template can never BE a step of the
 * journey — it can only ring the doorbell, after which the customer's reply
 * re-opens the service window and the real interactive prompt is replayed.
 *
 * Once you accept that, one generic "something needs your attention" template
 * covers a co-borrower request, a document request, Step-4 routing, an offer
 * arriving and dispatch being ready. Four approval cycles instead of eleven —
 * and, more usefully, the journey's ship date stops depending on Meta's review
 * queue, because a stage can go live before its bespoke template exists.
 */

export type WaTemplateKey =
  | "lead_action"
  | "dispatch_otp"
  | "sanctioned"
  | "dispatch_done";

export interface WaTemplateSpec {
  /** Name registered in Meta Business Manager. */
  name: string;
  lang: string;
  /** Ordered body parameters. The names document; the ORDER is the contract. */
  params: readonly string[];
  /** Env var that overrides `name`, for a sandbox WABA with different names. */
  envOverride: string;
  envLangOverride: string;
}

export const WA_TEMPLATES: Record<WaTemplateKey, WaTemplateSpec> = {
  /**
   * The doorbell. Deliberately vague about WHAT is needed, because the detail
   * arrives in the free-form prompt we replay once the window is open — and
   * because a vaguer template survives more journey changes without a re-review.
   */
  lead_action: {
    name: "itarang_lead_action_required",
    lang: "en",
    params: ["customerName", "referenceId", "whatIsNeeded"],
    envOverride: "WA_LEAD_ACTION_TEMPLATE",
    envLangOverride: "WA_LEAD_ACTION_TEMPLATE_LANG",
  },
  /**
   * Step-5 dispatch OTP. Separate from the calculator's OTP template because
   * the copy is different and a dispatch OTP routinely goes out more than 24h
   * after the customer last typed — this is the one that MUST be a template.
   */
  dispatch_otp: {
    name: "itarang_dispatch_otp",
    lang: "en",
    params: ["otp"],
    envOverride: "WA_DISPATCH_OTP_TEMPLATE",
    envLangOverride: "WA_DISPATCH_OTP_TEMPLATE_LANG",
  },
  sanctioned: {
    name: "itarang_loan_sanctioned",
    lang: "en",
    params: ["customerName", "nbfcName", "emiLine"],
    envOverride: "WA_SANCTION_TEMPLATE",
    envLangOverride: "WA_SANCTION_TEMPLATE_LANG",
  },
  dispatch_done: {
    name: "itarang_dispatch_done",
    lang: "en",
    params: ["customerName", "referenceId", "batterySerial"],
    envOverride: "WA_DISPATCH_DONE_TEMPLATE",
    envLangOverride: "WA_DISPATCH_DONE_TEMPLATE_LANG",
  },
};

export interface ResolvedTemplate {
  name: string;
  lang: string;
}

/**
 * Resolve a template to the name actually registered on the WABA in use.
 *
 * Returns null when no name is configured AND the built-in default has not been
 * approved yet — signalled by WA_TEMPLATES_APPROVED not listing the key. The
 * caller must treat null as "we cannot reach this customer right now" rather
 * than falling back to a free-form send Meta will reject with 131047.
 */
export function resolveTemplate(key: WaTemplateKey): ResolvedTemplate | null {
  const spec = WA_TEMPLATES[key];
  const override = process.env[spec.envOverride]?.trim();
  const name = override || (isApproved(key) ? spec.name : "");
  if (!name) return null;
  return {
    name,
    lang: process.env[spec.envLangOverride]?.trim() || spec.lang,
  };
}

/**
 * Which built-in template names have actually cleared Meta review.
 *
 * Comma-separated keys in WA_TEMPLATES_APPROVED, e.g. "lead_action,dispatch_otp".
 * This exists so a half-approved catalogue degrades honestly: an unapproved
 * stage parks its prompt and waits for the customer to come back on their own,
 * instead of firing a send that fails silently and looks like the customer
 * ignored us. Setting the explicit env override for a key also counts.
 */
function isApproved(key: WaTemplateKey): boolean {
  const raw = process.env.WA_TEMPLATES_APPROVED ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(key);
}

/** Count check, so a spec change cannot silently ship a param-count mismatch. */
export function assertParamCount(
  key: WaTemplateKey,
  params: readonly string[],
): void {
  const expected = WA_TEMPLATES[key].params.length;
  if (params.length !== expected) {
    throw new Error(
      `WhatsApp template ${key} expects ${expected} params (${WA_TEMPLATES[key].params.join(", ")}), got ${params.length}`,
    );
  }
}
