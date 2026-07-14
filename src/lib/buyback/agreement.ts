/**
 * Buyback agreements — Digio eSign for dealers AND vendors (M17/M18/M19, U12).
 *
 * THE THING THIS ACTUALLY CONTROLS: `business_entity_roles.status`. An entity with
 * no ACTIVE role cannot trade. A vendor with a PENDING role is invisible to the
 * routing query (it INNER JOINs on `status = 'ACTIVE'`), which is how M18's AC —
 * "unonboarded vendor unselectable for routing" — becomes true without the routing
 * screen having to remember to check anything.
 *
 * U12 — AN EXISTING DEALER DOES NOT RE-ONBOARD. The CRM already holds their
 * identity and KYC in `accounts`; buyback does not get its own copy. An existing
 * dealer of the same firm confirms their firm registration number and signs the
 * buyback agreement. That is the whole flow. There is no second wizard, no second
 * KYC store, and therefore no second place for a dealer's identity to drift.
 *
 * WHY ACTIVATION IS POLLED, NOT WEBHOOK-DRIVEN:
 * the repo's Digio webhook (`/api/webhooks/digio`) is a 506-line handler built
 * around NBFC loan agreements and their own status enum. Threading a second,
 * unrelated document type through it would put buyback's activation at the mercy
 * of a file that changes for reasons that have nothing to do with buyback. So we
 * poll Digio for the documents we care about. It is also simply more reliable:
 * a webhook that is never delivered fails silently forever, whereas a poller
 * catches up on its next tick.
 */

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { createDigioAgreement, getDigioDocumentStatus } from "@/lib/digio/service";
import { notifyRoles } from "@/lib/notifications/notify";
import { renderPdfFromHtml } from "@/lib/pdf/render-html";
import { putObject } from "@/lib/storage/s3";

import { BUYBACK_ADMIN_ROLES } from "./auth";
import { BUYBACK_BUCKET } from "./storage";
import type { BuybackTx } from "./tx";

export type BuybackRole = "BATTERY_DEALER" | "SCRAP_SELLER" | "SCRAP_VENDOR";

export interface AgreementParty {
  entity_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  gstin: string | null;
  city: string | null;
  state: string | null;
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * The agreement document.
 *
 * The NON-CIRCUMVENTION clause is the commercially load-bearing one, and it is
 * why the vendor never learns the dealer's identity anywhere else in this system:
 * iTarang is a back-to-back principal, and a vendor who can find the dealer can
 * cut us out of every future deal. The masking in the quotation PDF is the
 * technical half of this clause; this is the legal half. BRD §10 flags the exact
 * wording as Chirag's to finalise — what is here is a working draft, and it says
 * so.
 */
export function renderAgreementHtml(party: AgreementParty, role: BuybackRole): string {
  const isVendor = role === "SCRAP_VENDOR";
  const counterparty = isVendor ? "Vendor" : "Dealer";

  return `
<meta charset="utf-8" />
<style>
  body { font-family: Inter, "Helvetica Neue", Arial, sans-serif; color: #0F172A;
         font-size: 12px; line-height: 1.7; margin: 0; }
  .head { border-bottom: 2px solid #0B2239; padding-bottom: 12px; margin-bottom: 20px; }
  .brand { font-size: 19px; font-weight: 800; color: #0B2239; }
  .brand small { display: block; font-size: 10px; font-weight: 600; color: #64748B;
                 letter-spacing: .6px; text-transform: uppercase; margin-top: 3px; }
  h1 { font-size: 15px; margin: 0 0 16px; }
  h2 { font-size: 12.5px; margin: 18px 0 6px; }
  .party { background: #F8FAFC; border: 1px solid #E5E7EB; border-radius: 8px;
           padding: 12px 14px; margin-bottom: 16px; }
  .lbl { font-size: 9.5px; font-weight: 700; color: #94A3B8; text-transform: uppercase;
         letter-spacing: .5px; }
  .note { background: #FFFBEB; border: 1px solid #FDE68A; color: #92400E;
          border-radius: 8px; padding: 10px 12px; font-size: 10.5px; margin: 16px 0; }
  .sign { margin-top: 40px; display: flex; justify-content: space-between; }
  .sign div { width: 45%; border-top: 1px solid #94A3B8; padding-top: 6px;
              font-size: 10.5px; color: #64748B; }
</style>

<div class="head">
  <div class="brand">iTarang<small>Battery Buyback — ${esc(counterparty)} Agreement</small></div>
</div>

<h1>Battery Buyback ${esc(counterparty)} Agreement</h1>

<div class="party">
  <div class="lbl">Between</div>
  <div><b>iTarang Technologies</b> ("iTarang")</div>
  <div class="lbl" style="margin-top:8px;">And</div>
  <div>
    <b>${esc(party.name)}</b> (the "${esc(counterparty)}")<br />
    ${party.gstin ? `GSTIN ${esc(party.gstin)}<br />` : ""}
    ${[party.city, party.state].filter(Boolean).map(esc).join(", ")}
  </div>
</div>

<h2>1. Scope</h2>
<p>
  ${
    isVendor
      ? "iTarang sells end-of-life batteries to the Vendor as principal. The Vendor purchases on the terms of each quotation issued by iTarang and accepted by the Vendor."
      : "iTarang purchases end-of-life batteries from the Dealer as principal, at prices agreed per battery variant on the iTarang buyback portal."
  }
</p>

<h2>2. Pricing</h2>
<p>
  All prices are agreed <b>per battery variant</b>. No lump-sum figure for a lot is
  binding on either party. The prices recorded on the portal at the point of
  agreement are the operative prices, and neither party may vary them afterwards.
</p>

<h2>3. Non-circumvention</h2>
<p>
  ${
    isVendor
      ? "The Vendor acknowledges that iTarang trades as principal and does not disclose the identity of the parties from whom it acquires batteries. The Vendor shall not attempt to identify, approach or transact with any such party in respect of batteries offered to it by iTarang, whether directly or through an intermediary, for a period of twenty-four (24) months."
      : "The Dealer acknowledges that iTarang trades as principal and does not disclose the identity of the parties to whom it sells. The Dealer shall not attempt to identify, approach or transact with any such party in respect of batteries sold to iTarang, whether directly or through an intermediary, for a period of twenty-four (24) months."
  }
</p>

<h2>4. Provenance and compliance</h2>
<p>
  ${
    isVendor
      ? "The Vendor confirms it holds valid registration under the Battery Waste Management Rules, 2022, and shall handle all batteries acquired hereunder in accordance with those Rules."
      : "The Dealer warrants that it has good title to every battery offered, and shall provide provenance for each — the previous owner's identity and, where applicable, vehicle and purchase records. Batteries without provenance will not be accepted."
  }
</p>

<h2>5. Payment</h2>
<p>
  ${
    isVendor
      ? "Payment is due against iTarang's invoice, at the per-variant prices agreed."
      : "iTarang shall pay against the Dealer's invoice, at the locked per-variant prices, once the batteries have been collected and the collected counts confirmed. Where the collected count differs from the declared count, payment follows the Dealer's confirmation of the collected count."
  }
</p>

<div class="note">
  <b>Draft — pending legal review.</b> The non-circumvention wording and the GST /
  reverse-charge treatment are subject to final legal sign-off and may be amended
  before execution.
</div>

<div class="sign">
  <div>For iTarang Technologies</div>
  <div>For ${esc(party.name)}</div>
</div>
`;
}

/** Load the party we are asking to sign. */
export async function loadParty(entityId: string): Promise<AgreementParty | null> {
  const rows = await db.execute(sql`
    SELECT id AS entity_id, business_entity_name AS name, contact_email AS email,
           contact_phone AS phone, gstin, city, state
    FROM accounts WHERE id = ${entityId} LIMIT 1
  `);
  return (rows as unknown as AgreementParty[])[0] ?? null;
}

/**
 * Generate the agreement, send it to Digio, and record it as SENT.
 *
 * The role is created (or left) PENDING. Nothing is unlocked by SENDING an
 * agreement — only by its being signed.
 */
export async function sendAgreement(
  tx: BuybackTx,
  party: AgreementParty,
  role: BuybackRole,
  opts: { firmRegistrationNo?: string | null; actorId: string | null },
): Promise<{ agreementId: string; digioDocId: string | null }> {
  if (!party.email && !party.phone) {
    throw new Error(
      `${party.name} has neither an email nor a phone number, so Digio has nowhere to send the agreement.`,
    );
  }

  const pdf = await renderPdfFromHtml(renderAgreementHtml(party, role));
  const key = `buyback/agreements/${party.entity_id}-${role.toLowerCase()}.pdf`;
  await putObject(BUYBACK_BUCKET, key, pdf, "application/pdf");

  let digioDocId: string | null = null;
  try {
    const res = (await createDigioAgreement({
      fileData: pdf.toString("base64"),
      fileName: `itarang-buyback-${role.toLowerCase()}-${party.entity_id}.pdf`,
      signers: [
        {
          identifier: party.email || party.phone!,
          name: party.name,
          reason: "Battery buyback agreement",
          sign_type: "electronic",
        },
      ],
    })) as { id?: string };
    digioDocId = res?.id ?? null;
  } catch (error) {
    // Digio being down must not lose the document we just generated. The row is
    // written as DRAFT with the PDF attached; a retry can re-send it.
    const message = error instanceof Error ? error.message : String(error);
    const rows = await tx.execute(sql`
      INSERT INTO agreements (entity_id, role, firm_registration_no, status, pdf_s3,
                              declined_reason, created_by)
      VALUES (${party.entity_id}, ${role}::buyback_entity_role,
              ${opts.firmRegistrationNo ?? null}, 'DRAFT', ${key},
              ${`Digio send failed: ${message}`.slice(0, 500)}, ${opts.actorId})
      RETURNING id
    `);
    return {
      agreementId: String((rows as unknown as Array<{ id: string }>)[0].id),
      digioDocId: null,
    };
  }

  const rows = await tx.execute(sql`
    INSERT INTO agreements (entity_id, role, digio_doc_id, firm_registration_no,
                            status, pdf_s3, sent_at, created_by)
    VALUES (${party.entity_id}, ${role}::buyback_entity_role, ${digioDocId},
            ${opts.firmRegistrationNo ?? null}, 'SENT', ${key}, now(), ${opts.actorId})
    RETURNING id
  `);

  // The role exists but stays PENDING. Sending is not signing.
  await tx.execute(sql`
    INSERT INTO business_entity_roles (entity_id, role, status)
    VALUES (${party.entity_id}, ${role}::buyback_entity_role, 'PENDING')
    ON CONFLICT (entity_id, role) DO NOTHING
  `);

  return {
    agreementId: String((rows as unknown as Array<{ id: string }>)[0].id),
    digioDocId,
  };
}

/**
 * Poll Digio for every agreement still out for signature, and activate the role
 * of anyone who has signed.
 *
 * THE ACTIVATION IS THE POINT. Marking the agreement SIGNED is bookkeeping;
 * flipping business_entity_roles.status to ACTIVE is what lets the entity trade —
 * and, for a vendor, what makes them appear in the routing screen at all.
 */
export async function syncAgreements(): Promise<{
  checked: number;
  signed: number;
  declined: number;
}> {
  const pending = (await db.execute(sql`
    SELECT a.id, a.digio_doc_id, a.entity_id, a.role, acc.business_entity_name AS name
    FROM agreements a
    JOIN accounts acc ON acc.id = a.entity_id
    WHERE a.status = 'SENT' AND a.digio_doc_id IS NOT NULL
  `)) as unknown as Array<{
    id: string;
    digio_doc_id: string;
    entity_id: string;
    role: string;
    name: string;
  }>;

  let signed = 0;
  let declined = 0;

  for (const a of pending) {
    let status: string;
    try {
      const doc = (await getDigioDocumentStatus(a.digio_doc_id)) as {
        agreement_status?: string;
      };
      status = String(doc?.agreement_status ?? "").toLowerCase();
    } catch {
      // Digio unreachable for this document — leave it SENT and try next tick.
      continue;
    }

    if (status === "completed" || status === "signed") {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          UPDATE agreements SET status = 'SIGNED', signed_at = now(), updated_at = now()
          WHERE id = ${a.id}
        `);

        // THE UNLOCK.
        await tx.execute(sql`
          UPDATE business_entity_roles
          SET status = 'ACTIVE', agreement_id = ${a.id}, updated_at = now()
          WHERE entity_id = ${a.entity_id} AND role = ${a.role}::buyback_entity_role
        `);
      });

      signed += 1;

      await notifyRoles([...BUYBACK_ADMIN_ROLES], {
        type: "buyback.agreement_signed",
        title: `${a.name} signed the buyback agreement`,
        message:
          a.role === "SCRAP_VENDOR"
            ? `${a.name} has signed and is now selectable for vendor routing.`
            : `${a.name} has signed and can now raise buyback requests.`,
        data: { entity_id: a.entity_id, role: a.role },
      }).catch(() => {});
    } else if (status === "declined" || status === "expired" || status === "failed") {
      await db.execute(sql`
        UPDATE agreements
        SET status = ${status === "expired" ? "EXPIRED" : "DECLINED"}::buyback_agreement_status,
            updated_at = now()
        WHERE id = ${a.id}
      `);
      declined += 1;
    }
  }

  return { checked: pending.length, signed, declined };
}
