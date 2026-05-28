/**
 * Pull-based reconciliation of NBFC LSP agreement signing status from Digio.
 *
 * Why: the configured Digio webhook URL points at /api/webhooks/digio
 * (hardcoded in src/lib/digio/mapper.ts) which was built for the dealer
 * consent flow. NBFC partial-signing events (one of N signers done) leave
 * nbfc_lsp_agreement_signers rows stranded on `sent`, and the CEO/admin
 * SIGNING STATUS panel shows "Pending" forever. This helper closes that gap
 * by polling Digio's GET document API on page load.
 *
 * Best-effort: never throws. If Digio is unreachable, we render whatever is
 * already in the DB. Idempotent — already-`signed` rows are skipped and
 * COMPLETED agreements short-circuit.
 *
 * Called from:
 *   - /admin/nbfc/[nbfcId]/approval
 *   - /admin/nbfc/[nbfcId]/review
 */
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  nbfc,
  nbfcLspAgreements,
  nbfcLspAgreementSigners,
} from "@/lib/db/schema";
import { getDigioBaseUrl, getDigioBasicAuth } from "@/lib/digio/client";

const SIGNER_SIGNED_STATUSES = new Set([
  "signed",
  "completed",
  "executed",
  "success",
]);

const AGREEMENT_TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "EXPIRED",
]);

interface DigioParty {
  identifier?: string;
  customer_identifier?: string;
  status?: string;
  signed_at?: string;
}

interface DigioDocResponse {
  signing_parties?: DigioParty[];
  agreement_status?: string;
  status?: string;
  [k: string]: unknown;
}

async function fetchDigioDocument(
  baseUrl: string,
  auth: string,
  documentId: string,
): Promise<DigioDocResponse | null> {
  const urls = [
    `${baseUrl}/v2/client/document/${encodeURIComponent(documentId)}`,
    `${baseUrl}/v2/client/document/status/${encodeURIComponent(documentId)}`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Authorization: auth, Accept: "application/json" },
        cache: "no-store",
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text) continue;
      return JSON.parse(text) as DigioDocResponse;
    } catch (err) {
      console.warn("[sync-lsp-signer-status] Digio fetch error", {
        url,
        err: err instanceof Error ? err.message : err,
      });
    }
  }
  return null;
}

export async function syncLspSignerStatusFromDigio(
  nbfcId: number,
): Promise<void> {
  try {
    // Resolve the canonical agreement row the same way the trigger does:
    // prefer `nbfc.lsp_agreement_id` (set on every admin /initiate submit)
    // and fall back to the most-recent row. This keeps reader and writer
    // aligned across CEO-correction cycles where multiple agreement rows
    // exist for the same NBFC.
    const [nbfcRow] = await db
      .select({ lsp_agreement_id: nbfc.lsp_agreement_id })
      .from(nbfc)
      .where(eq(nbfc.id, nbfcId))
      .limit(1);

    const [agreement] = nbfcRow?.lsp_agreement_id
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
    if (!agreement) return;
    if (!agreement.digio_document_id) return;
    // Terminal-state guard: only skip when there's truly nothing left to
    // recover. A COMPLETED row whose `signed_pdf_url`/`audit_trail_url`
    // never got populated (e.g. Digio's PDF wasn't ready when we first
    // polled) still needs the fetcher to run; otherwise the panel stays
    // stuck on the "Fetching signed agreement from Digio…" spinner forever.
    const hasPdfUrls = !!(
      agreement.signed_pdf_url && agreement.audit_trail_url
    );
    const isTerminal = AGREEMENT_TERMINAL_STATUSES.has(
      agreement.agreement_status ?? "",
    );
    if (isTerminal && hasPdfUrls) return;

    const auth = getDigioBasicAuth();
    if (!auth) return;
    const baseUrl = getDigioBaseUrl();
    const parsed = await fetchDigioDocument(
      baseUrl,
      auth,
      agreement.digio_document_id,
    );
    if (!parsed) return;

    const signingParties: DigioParty[] = Array.isArray(parsed.signing_parties)
      ? parsed.signing_parties
      : [];
    const rawAgreementStatus = String(
      parsed.agreement_status ?? parsed.status ?? "",
    ).toUpperCase();

    const signers = await db
      .select()
      .from(nbfcLspAgreementSigners)
      .where(eq(nbfcLspAgreementSigners.nbfc_lsp_agreement_id, agreement.id));

    const byEmail = new Map<string, (typeof signers)[number]>();
    for (const s of signers) byEmail.set(s.email.toLowerCase(), s);

    const now = new Date();
    let anyUpdated = false;

    for (const party of signingParties) {
      // Digio's GET document response uses either `identifier` or
      // `customer_identifier` depending on the endpoint variant; accept both.
      const identifier = String(
        party?.identifier ?? party?.customer_identifier ?? "",
      ).toLowerCase();
      if (!identifier) continue;
      const row = byEmail.get(identifier);
      if (!row) continue;
      const partyStatus = String(party?.status ?? "").toLowerCase();
      if (!SIGNER_SIGNED_STATUSES.has(partyStatus)) continue;
      if (row.signing_status === "signed") continue;
      const parsedSignedAt = party.signed_at ? new Date(party.signed_at) : now;
      const signedAt = Number.isNaN(parsedSignedAt.getTime())
        ? now
        : parsedSignedAt;
      await db
        .update(nbfcLspAgreementSigners)
        .set({
          signing_status: "signed",
          signed_at: signedAt,
          last_status_event_at: now,
        })
        .where(eq(nbfcLspAgreementSigners.id, row.id));
      anyUpdated = true;
    }

    const signedCount = signingParties.filter((p) =>
      SIGNER_SIGNED_STATUSES.has(String(p?.status ?? "").toLowerCase()),
    ).length;
    console.info("[sync-lsp-signer-status]", {
      nbfcId,
      agreementId: agreement.id,
      digioDocumentId: agreement.digio_document_id,
      digioStatus: rawAgreementStatus,
      partyCount: signingParties.length,
      signedCount,
      dbUpdated: anyUpdated,
      hasPdfUrls,
    });

    const refreshedSigners = anyUpdated
      ? await db
          .select()
          .from(nbfcLspAgreementSigners)
          .where(
            eq(nbfcLspAgreementSigners.nbfc_lsp_agreement_id, agreement.id),
          )
      : signers;
    const allSigned =
      refreshedSigners.length > 0 &&
      refreshedSigners.every((s) => s.signing_status === "signed");
    const digioSaysComplete =
      rawAgreementStatus === "COMPLETED" ||
      rawAgreementStatus === "SIGNED" ||
      rawAgreementStatus === "EXECUTED";

    const existingPayload =
      (agreement.last_webhook_payload as Record<string, unknown>) ?? {};

    // Fire the completion branch only when the agreement isn't already
    // COMPLETED. Once it's COMPLETED, the download buttons hit the proxy
    // routes (/api/admin/nbfc/[id]/lsp-agreement/{signed-pdf,audit-trail})
    // which fetch from Digio on demand — no need to prefetch PDFs here.
    const needsCompletion =
      (allSigned || digioSaysComplete) &&
      agreement.agreement_status !== "COMPLETED";

    if (needsCompletion) {
      await db
        .update(nbfcLspAgreements)
        .set({
          agreement_status: "COMPLETED",
          signing_date:
            agreement.signing_date ?? now.toISOString().slice(0, 10),
          completed_at: agreement.completed_at ?? now,
          updated_at: now,
          last_webhook_payload: {
            ...existingPayload,
            last_pull: parsed as unknown as Record<string, unknown>,
            last_pull_at: now.toISOString(),
          },
        })
        .where(eq(nbfcLspAgreements.id, agreement.id));

      await db
        .update(nbfc)
        .set({ lsp_agreement_id: agreement.id, updated_at: now })
        .where(eq(nbfc.id, agreement.nbfc_id));
    } else if (anyUpdated) {
      await db
        .update(nbfcLspAgreements)
        .set({
          updated_at: now,
          last_webhook_payload: {
            ...existingPayload,
            last_pull: parsed as unknown as Record<string, unknown>,
            last_pull_at: now.toISOString(),
          },
        })
        .where(eq(nbfcLspAgreements.id, agreement.id));
    }
  } catch (err) {
    console.warn("[sync-lsp-signer-status] unexpected error", err);
  }
}
