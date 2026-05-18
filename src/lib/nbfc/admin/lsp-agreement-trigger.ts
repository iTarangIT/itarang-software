/**
 * E-112 — Fire Digio multi-template create_sign_request after CEO approval.
 *
 * Called from the CEO approve route once the NBFC has been flipped to
 * 'approved'. Loads the agreement bundle (parent + signers), shapes the Digio
 * payload (Aadhaar e-sign, sequential, NBFC_ callback), POSTs, and stamps the
 * returned Digio document id + per-signer 'sent' state.
 *
 * Failure semantics: throws on Digio non-2xx. The caller (approve route) does
 * NOT roll back the NBFC approval — CEO's decision stands, and the admin can
 * re-trigger via POST /api/admin/nbfc/{id}/lsp-agreement/resend.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  nbfc,
  nbfcLspAgreements,
  nbfcLspAgreementSigners,
} from "@/lib/db/schema";
import {
  createMultiTemplateSignRequest,
  type MultiTemplateCreateInput,
} from "@/lib/digio/multi-templates";

export interface TriggerResult {
  digioDocumentId: string;
  agreementId: number;
  signerCount: number;
}

// Canonical iTarang legal name (matches src/lib/consent/consent-pdf-template.ts).
// Used as the "company" half of the per-signer `reason` field for iTarang-party
// signers, so the signed PDF's signature stamp reads e.g.
// "Reason: Developer, iTarang Technologies LLP …" instead of just "Developer".
const ITARANG_LEGAL_NAME = "iTarang Technologies LLP";

function getWebhookCallback(nbfcId: number): string {
  return `NBFC_${nbfcId}`;
}

/** Resolve the Digio template key configured for NBFC LSP agreements. Falls
 * back to the dealer template id in sandbox so signing still proceeds end-to-
 * end during development. Production must set NBFC_LSP_DIGIO_TEMPLATE_KEY. */
function resolveTemplateKey(): string {
  const key =
    process.env.NBFC_LSP_DIGIO_TEMPLATE_KEY?.trim() ||
    process.env.DIGIO_TEMPLATE_ID?.trim();
  if (!key) {
    throw new Error(
      "NBFC_LSP_DIGIO_TEMPLATE_KEY (or fallback DIGIO_TEMPLATE_ID) is not set",
    );
  }
  return key;
}

function resolveExpireInDays(): number {
  const raw = process.env.NBFC_LSP_EXPIRE_IN_DAYS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0 && n <= 365) return n;
  }
  return 14;
}

/**
 * Trigger Digio signing for the NBFC LSP agreement. Idempotent on the agreement
 * row — re-running on an already-SENT agreement is a no-op (returns the
 * existing digio_document_id).
 */
export async function triggerLspSigning(
  nbfcId: number,
): Promise<TriggerResult> {
  // 1) Load NBFC + parent agreement. Pick the canonical row via
  // `nbfc.lsp_agreement_id` (set by /initiate on every admin submit, so it
  // always points at the latest version the CEO actually approved). Fall
  // back to the most-recent row by created_at for legacy NBFCs where the FK
  // wasn't backfilled. Previously this used `orderBy(id ASC)` which picked
  // the OLDEST row — for any NBFC that had gone through a CEO correction
  // cycle, this stamped digio_document_id onto a pre-correction row while
  // the UI read the post-correction row, leaving the SIGNING STATUS panel
  // stuck on "Pending" forever.
  const [nbfcRow] = await db
    .select({
      id: nbfc.id,
      legal_name: nbfc.legal_name,
      nbfc_id: nbfc.nbfc_id,
      pan_number: nbfc.pan_number,
      gst_number: nbfc.gst_number,
      rbi_registration_no: nbfc.rbi_registration_no,
      lsp_agreement_id: nbfc.lsp_agreement_id,
    })
    .from(nbfc)
    .where(eq(nbfc.id, nbfcId))
    .limit(1);
  if (!nbfcRow) {
    throw new Error(`NBFC ${nbfcId} not found`);
  }

  const [agreement] = nbfcRow.lsp_agreement_id
    ? await db
        .select()
        .from(nbfcLspAgreements)
        .where(eq(nbfcLspAgreements.id, nbfcRow.lsp_agreement_id))
        .limit(1)
    : await db
        .select()
        .from(nbfcLspAgreements)
        .where(eq(nbfcLspAgreements.nbfc_id, nbfcId))
        .orderBy(desc(nbfcLspAgreements.created_at))
        .limit(1);
  if (!agreement) {
    throw new Error(`No LSP agreement row for NBFC ${nbfcId}`);
  }

  // Idempotency — already sent? Return the existing document id.
  if (
    agreement.digio_document_id &&
    (agreement.agreement_status === "SENT_FOR_SIGNATURE" ||
      agreement.agreement_status === "SIGNED" ||
      agreement.agreement_status === "COMPLETED")
  ) {
    return {
      digioDocumentId: agreement.digio_document_id,
      agreementId: agreement.id,
      signerCount: 0,
    };
  }

  const signers = await db
    .select()
    .from(nbfcLspAgreementSigners)
    .where(eq(nbfcLspAgreementSigners.nbfc_lsp_agreement_id, agreement.id))
    .orderBy(asc(nbfcLspAgreementSigners.signer_order));
  if (signers.length === 0) {
    throw new Error(`No signers configured for agreement ${agreement.id}`);
  }

  // 2) Shape Digio payload.
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
  const templateValues: Record<string, unknown> = {
    nbfc_legal_name: nbfcRow.legal_name ?? "",
    nbfc_public_id: nbfcRow.nbfc_id ?? "",
    nbfc_pan: nbfcRow.pan_number ?? "",
    nbfc_gst: nbfcRow.gst_number ?? "",
    nbfc_rbi_no: nbfcRow.rbi_registration_no ?? "",
    agreement_id: agreement.agreement_id ?? "",
    agreement_date: todayIso,
  };
  // Per-signer name + designation tokens (signer_1_name, signer_1_designation, …)
  signers.forEach((s, i) => {
    templateValues[`signer_${i + 1}_name`] = s.full_name;
    templateValues[`signer_${i + 1}_designation`] = s.designation;
    templateValues[`signer_${i + 1}_email`] = s.email;
  });

  // Build per-signer reason as "{designation}, {company}" so the signed
  // PDF's signature stamp makes each signer's actual employer explicit:
  // NBFC signers attribute to the NBFC's Step 1 legal name; iTarang
  // signers attribute to iTarang Technologies LLP. (Digio still
  // auto-appends the Digio account org name to this line — see plan for
  // the dashboard-side action to fix that suffix.)
  const nbfcLegalName = nbfcRow.legal_name?.trim() || "NBFC";

  const payload: MultiTemplateCreateInput = {
    templates: [
      {
        template_key: resolveTemplateKey(),
        template_values: templateValues,
      },
    ],
    signers: signers.map((s) => {
      const company = s.party === "nbfc" ? nbfcLegalName : ITARANG_LEGAL_NAME;
      return {
        identifier: s.email,
        name: s.full_name,
        reason: `${s.designation}, ${company}`,
        sign_type: "aadhaar",
      };
    }),
    sequential: true,
    expire_in_days: resolveExpireInDays(),
    notify_signers: true,
    customer_notification_mode: "all",
    callback: getWebhookCallback(nbfcId),
  };

  // 3) Call Digio.
  const response = await createMultiTemplateSignRequest(payload);
  const digioDocumentId = response.id;
  if (!digioDocumentId) {
    throw new Error("Digio create_sign_request returned no document id");
  }

  // 4) Persist — stamp agreement + every signer in a single transaction.
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(nbfcLspAgreements)
      .set({
        digio_document_id: digioDocumentId,
        digio_request_id: digioDocumentId,
        agreement_status: "SENT_FOR_SIGNATURE",
        initiated_at: now,
        updated_at: now,
        last_webhook_payload: response as unknown as Record<string, unknown>,
      })
      .where(eq(nbfcLspAgreements.id, agreement.id));

    for (const s of signers) {
      await tx
        .update(nbfcLspAgreementSigners)
        .set({
          signing_status: "sent",
          digio_signer_identifier: s.email,
          last_status_event_at: now,
        })
        .where(eq(nbfcLspAgreementSigners.id, s.id));
    }
  });

  return {
    digioDocumentId,
    agreementId: agreement.id,
    signerCount: signers.length,
  };
}

/** Used by the resend endpoint — clears any 'expired' per-signer rows back to
 * 'sent' after a fresh Digio trigger. */
export async function resetExpiredSignersToSent(
  agreementId: number,
): Promise<void> {
  const now = new Date();
  await db
    .update(nbfcLspAgreementSigners)
    .set({ signing_status: "sent", last_status_event_at: now })
    .where(
      and(
        eq(nbfcLspAgreementSigners.nbfc_lsp_agreement_id, agreementId),
        eq(nbfcLspAgreementSigners.signing_status, "expired"),
      ),
    );
}
