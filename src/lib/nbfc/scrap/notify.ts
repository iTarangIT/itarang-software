/**
 * E-258 — the scrap-consignment notifications, both directions.
 *
 * Every move in this deal has to reach the OTHER dashboard, because neither
 * side is watching a queue: the NBFC posts scrap and goes back to collections,
 * iTarang admin prices it and goes back to onboarding. So each function here
 * fans one business event out to both parties with per-recipient copy and a
 * deep link into that party's own screen — which is exactly what `emit()` was
 * generalised for, so nothing new is invented here.
 *
 * BEST-EFFORT BY CONTRACT. `emit()` never throws; these wrappers add nothing
 * that can. A notification is never the reason a deal move fails.
 *
 * The NBFC audience is `{kind:'nbfc', tenantId}` — every seat of that tenant.
 * The iTarang audience is `ADMIN_AUDIENCE_ROLES` (admin, ceo, business_head,
 * sales_head): everyone who can SEE the deal gets told, which is deliberately
 * wider than the two roles allowed to price and accept it.
 */
import {
  ADMIN_AUDIENCE_ROLES,
  emit,
  type Recipient,
} from "@/lib/notifications/emit";
import {
  ADMIN_PARTY,
  SYSTEM_PARTY,
  nbfcParty,
} from "@/lib/notifications/provenance";
import type { Consignment } from "@/lib/nbfc/scrap/consignment";

const inr = (n: number | null | undefined) =>
  n == null ? "—" : `₹${Math.round(n).toLocaleString("en-IN")}`;

const adminHref = (c: Consignment) => `/admin/nbfc/scrap?open=${c.id}`;
const nbfcHref = (c: Consignment) => `/nbfc/recovery/scrap?open=${c.id}`;

const lotLine = (c: Consignment) =>
  `${c.battery_count} scrap ${c.battery_count === 1 ? "battery" : "batteries"} · ${c.ref_code}`;

function adminRecipient(c: Consignment, copy: Partial<Recipient> = {}): Recipient {
  return {
    audience: { kind: "roles", roles: ADMIN_AUDIENCE_ROLES },
    as: ADMIN_PARTY,
    href: adminHref(c),
    ...copy,
  };
}

function nbfcRecipient(c: Consignment, copy: Partial<Recipient> = {}): Recipient {
  return {
    audience: { kind: "nbfc", tenantId: c.tenant_id },
    as: nbfcParty(c.tenant_name ?? "NBFC"),
    href: nbfcHref(c),
    ...copy,
  };
}

const baseData = (c: Consignment) => ({
  consignment_id: c.id,
  ref_code: c.ref_code,
  battery_count: c.battery_count,
});

/** The NBFC has put scrap in front of iTarang. Admin's move. */
export async function notifyScrapSubmitted(c: Consignment): Promise<void> {
  await emit({
    type: "scrap.consignment_submitted",
    title: `Scrap offered: ${lotLine(c)}`,
    message: `${c.tenant_name ?? "An NBFC"} is offering ${c.battery_count} scrap ${
      c.battery_count === 1 ? "battery" : "batteries"
    } at ${inr(c.asking_rate_per_battery)} each (${inr(
      (c.asking_rate_per_battery ?? 0) * c.battery_count,
    )} in total). Review the photographs and put your price on it.`,
    stage: "Scrap sale",
    from: nbfcParty(c.tenant_name ?? "NBFC"),
    data: baseData(c),
    to: [
      adminRecipient(c),
      nbfcRecipient(c, {
        title: `Scrap consignment ${c.ref_code} sent to iTarang`,
        message: `${lotLine(c)} at ${inr(c.asking_rate_per_battery)} each is with iTarang. You will be told when they answer.`,
      }),
    ],
  });
}

/** Someone put a new rate on the table. Tells the side that now owes an answer. */
export async function notifyScrapCountered(
  c: Consignment,
  by: "nbfc" | "admin",
  rate: number | null,
  /** [E-260] The countered total. Required for an itemised lot, which has no rate. */
  amount: number | null = null,
): Promise<void> {
  const total = amount ?? (rate != null ? rate * c.battery_count : null);
  const who = by === "admin" ? "iTarang" : (c.tenant_name ?? "The NBFC");
  // [E-260] An itemised lot has no single rate to quote, so the notification
  // leads with the total instead of saying "₹— per battery".
  const priceLine =
    rate != null
      ? `${inr(rate)} per battery — ${inr(total)}`
      : `${inr(total)} for the lot`;
  await emit({
    type: "scrap.offer_countered",
    title: `New scrap price on ${c.ref_code}`,
    message: `${who} countered at ${priceLine} for ${lotLine(c)}.`,
    stage: "Scrap sale",
    from: by === "admin" ? ADMIN_PARTY : nbfcParty(c.tenant_name ?? "NBFC"),
    data: { ...baseData(c), rate_per_battery: rate, amount: total, by },
    to:
      by === "admin"
        ? [
            nbfcRecipient(c, {
              message: `iTarang countered at ${priceLine} for ${lotLine(c)}. Accept it or counter back.`,
            }),
            adminRecipient(c, {
              title: `Your counter on ${c.ref_code} was sent`,
              message: `${priceLine} — is with ${c.tenant_name ?? "the NBFC"}.`,
            }),
          ]
        : [
            adminRecipient(c, {
              message: `${c.tenant_name ?? "The NBFC"} countered at ${priceLine} for ${lotLine(c)}. Accept it or counter back.`,
            }),
            nbfcRecipient(c, {
              title: `Your counter on ${c.ref_code} was sent`,
              message: `${priceLine} — is with iTarang.`,
            }),
          ],
  });
}

/** The rate is agreed. Both dashboards, because both now owe something. */
export async function notifyScrapAgreed(
  c: Consignment,
  by: "nbfc" | "admin",
): Promise<void> {
  await emit({
    type: "scrap.deal_agreed",
    title: `Scrap deal agreed — ${c.ref_code}`,
    message: `${inr(c.agreed_rate_per_battery)} per battery × ${c.battery_count} = ${inr(c.agreed_amount)}. ${
      by === "admin" ? "iTarang" : (c.tenant_name ?? "The NBFC")
    } accepted.`,
    stage: "Scrap sale",
    from: by === "admin" ? ADMIN_PARTY : nbfcParty(c.tenant_name ?? "NBFC"),
    data: {
      ...baseData(c),
      rate_per_battery: c.agreed_rate_per_battery,
      amount: c.agreed_amount,
    },
    to: [
      adminRecipient(c, {
        message: `${lotLine(c)} agreed at ${inr(c.agreed_amount)} (${inr(c.agreed_rate_per_battery)} each). Pay to take the lot.`,
      }),
      nbfcRecipient(c, {
        message: `${lotLine(c)} agreed at ${inr(c.agreed_amount)} (${inr(c.agreed_rate_per_battery)} each). iTarang will pay and collect.`,
      }),
    ],
  });
}

/**
 * The deal ended without a sale — iTarang declined, the NBFC declined the
 * price, or the NBFC pulled the consignment back.
 *
 * `by` matters as much as `kind` here: "declined" reads very differently
 * depending on which side said it, and getting that backwards in a bell row is
 * the kind of thing that starts a phone call.
 */
export async function notifyScrapClosed(
  c: Consignment,
  kind: "reject" | "withdraw",
  message: string | null,
  by: "nbfc" | "admin",
): Promise<void> {
  const reason = message?.trim() ? ` Reason: ${message.trim()}` : "";
  const nbfcName = c.tenant_name ?? "The NBFC";
  const headline =
    kind === "withdraw"
      ? `Scrap ${c.ref_code} was withdrawn`
      : by === "admin"
        ? `iTarang declined scrap ${c.ref_code}`
        : `${nbfcName} declined iTarang's price on ${c.ref_code}`;
  const body =
    kind === "withdraw"
      ? `${nbfcName} withdrew ${lotLine(c)}.${reason}`
      : by === "admin"
        ? `iTarang will not be buying ${lotLine(c)}.${reason} The batteries are free to offer again.`
        : `${nbfcName} will not sell ${lotLine(c)} at the price offered.${reason}`;

  await emit({
    type: "scrap.consignment_closed",
    title: headline,
    message: body,
    stage: "Scrap sale",
    from: by === "admin" ? ADMIN_PARTY : nbfcParty(nbfcName),
    data: { ...baseData(c), kind, by },
    to: [adminRecipient(c), nbfcRecipient(c)],
  });
}

/** Money moved and the lot is iTarang's. The one both sides wait for. */
export async function notifyScrapPaid(c: Consignment): Promise<void> {
  const ref = c.payment_utr ?? c.payment_ref;
  await emit({
    type: "scrap.payment_settled",
    title: `Scrap ${c.ref_code} paid — ${inr(c.agreed_amount)}`,
    message: `iTarang has paid ${inr(c.agreed_amount)} for ${lotLine(c)}${
      ref ? ` (ref ${ref})` : ""
    }. The batteries have transferred to iTarang.`,
    stage: "Scrap sale",
    from: SYSTEM_PARTY,
    data: {
      ...baseData(c),
      amount: c.agreed_amount,
      provider: c.payment_provider,
      reference: ref,
    },
    to: [
      adminRecipient(c, {
        message: `${inr(c.agreed_amount)} paid to ${c.tenant_name ?? "the NBFC"} for ${lotLine(c)}${
          ref ? ` (ref ${ref})` : ""
        }. The lot is yours to collect.`,
      }),
      nbfcRecipient(c, {
        message: `iTarang has paid ${inr(c.agreed_amount)} for ${lotLine(c)}${
          ref ? ` (ref ${ref})` : ""
        }. The batteries have left your register.`,
      }),
    ],
  });
}
