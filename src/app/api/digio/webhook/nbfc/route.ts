/**
 * E-008 — POST /api/digio/webhook/nbfc
 *
 * Digio webhook handler for the NBFC LSP Agreement flow. The shared Digio
 * dealer + NBFC flows are routed apart by the `callback` field embedded in
 * the original create_sign_request payload (see E-007). When Digio reports
 * status changes, it echoes that callback back to us; this route is the
 * NBFC-prefixed sibling of the dealer webhook (`/api/webhooks/digio`).
 *
 * Behaviour (per BRD 6.0.4a + Sync Audit G-01 / G-08):
 *   1. Validate body with zod and reject any callback that doesn't match
 *      `/^NBFC_\d+$/` (returns 400 — distinguishes NBFC callbacks from
 *      dealer callbacks at the routing layer).
 *   2. Look up the matching `nbfc_lsp_agreements` row by `agreement_id`.
 *   3. Idempotency: if the persisted `agreement_status` is already at or
 *      ahead of the incoming status (per the shared ENUM ordinal order),
 *      return 200 ok with `idempotent: true` and no DB writes — replays
 *      cannot regress state nor duplicate signed_pdf_url updates.
 *   4. On `COMPLETED`, fetch signed_pdf + audit_trail (stubbed in test
 *      mode) and persist URLs along with `signing_date = today`. Then
 *      backfill `nbfc.lsp_agreement_id` so downstream loan_sanctions can
 *      audit-link to the LSP agreement (BRD 6.0.7).
 *   5. Always persist the raw incoming Digio payload to
 *      `last_webhook_payload.last_event` for replay/debug.
 *
 * Auth: public — Digio cannot carry a Supabase cookie. Production should
 * verify the Digio webhook signature; the dealer-side handler at
 * `/api/webhooks/digio` currently relies on payload shape + correlation,
 * and we mirror that here for parity. Signature verification is tracked
 * separately by the shared verifier slot in the dealer flow.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfc, nbfcLspAgreements } from "@/lib/db/schema";
import { fetchSignedLspPdfAndAuditTrail } from "@/lib/queue/jobs/fetchSignedLspPdfJob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Shared agreement_status ENUM (Sync Audit G-01). The ordinal order encodes
// the legal forward direction; any incoming status with a smaller (or equal)
// ordinal than what's already persisted is a no-op idempotent replay.
const STATUS_ORDER: Record<string, number> = {
  DRAFT: 0,
  INITIATED: 1,
  IN_PROGRESS: 2,
  SENT_TO_EXTERNAL_PARTY: 3,
  SIGN_PENDING: 4,
  PARTIALLY_SIGNED: 5,
  SIGNED: 6,
  COMPLETED: 7,
  // Terminal failure states sit alongside COMPLETED — once entered, they
  // also block forward transitions.
  FAILED: 7,
  EXPIRED: 7,
};

const NBFC_CALLBACK_RE = /^NBFC_(\d+)$/;

const WebhookBody = z.object({
  payload: z.object({
    agreement_id: z.string().min(1),
    agreement_status: z.enum([
      "SENT_TO_EXTERNAL_PARTY",
      "SIGN_PENDING",
      "PARTIALLY_SIGNED",
      "SIGNED",
      "COMPLETED",
      "FAILED",
      "EXPIRED",
    ]),
    callback: z.string().regex(NBFC_CALLBACK_RE),
    signed_document_url: z.string().url().optional(),
    audit_trail_url: z.string().url().optional(),
  }),
});

function isAtOrAhead(current: string | null | undefined, incoming: string): boolean {
  const cur = STATUS_ORDER[String(current ?? "")] ?? -1;
  const inc = STATUS_ORDER[incoming] ?? -1;
  return cur >= inc;
}

export async function POST(req: NextRequest) {
  // Parse JSON body. Malformed JSON → 400.
  let bodyJson: unknown = {};
  try {
    const text = await req.text();
    bodyJson = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = WebhookBody.safeParse(bodyJson);
  if (!parsed.success) {
    // Surface a stable error code for callback-shape failures so callers
    // (and logs) can distinguish "your callback prefix is wrong" from
    // generic validation noise. AC2 specifies 400 for non-NBFC callbacks.
    const callbackIssue = parsed.error.issues.find((iss) =>
      iss.path.includes("callback"),
    );
    return NextResponse.json(
      {
        ok: false,
        error: callbackIssue ? "INVALID_CALLBACK_PREFIX" : "VALIDATION",
        issues: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  const { payload } = parsed.data;
  const callbackMatch = payload.callback.match(NBFC_CALLBACK_RE);
  // The zod regex above guarantees this matches; the cast is defensive.
  const nbfcIdFromCallback = callbackMatch ? Number.parseInt(callbackMatch[1], 10) : NaN;
  if (!Number.isInteger(nbfcIdFromCallback) || nbfcIdFromCallback <= 0) {
    return NextResponse.json(
      { ok: false, error: "INVALID_CALLBACK_PREFIX" },
      { status: 400 },
    );
  }

  // Look up agreement row.
  const [row] = await db
    .select()
    .from(nbfcLspAgreements)
    .where(eq(nbfcLspAgreements.agreement_id, payload.agreement_id));
  if (!row) {
    return NextResponse.json(
      { ok: false, error: "AGREEMENT_NOT_FOUND", agreement_id: payload.agreement_id },
      { status: 404 },
    );
  }

  // Idempotency: replays cannot regress state nor duplicate side-effects.
  if (isAtOrAhead(row.agreement_status, payload.agreement_status)) {
    // Still record the replay payload so audit reflects every Digio event
    // — but DO NOT touch agreement_status, signed_pdf_url, audit_trail_url,
    // signing_date, or nbfc.lsp_agreement_id.
    const existing = (row.last_webhook_payload as Record<string, unknown>) ?? {};
    await db
      .update(nbfcLspAgreements)
      .set({
        last_webhook_payload: { ...existing, last_event: payload, idempotent_replay: true },
        updated_at: new Date(),
      })
      .where(eq(nbfcLspAgreements.id, row.id));
    return NextResponse.json({
      ok: true,
      idempotent: true,
      agreement_status: row.agreement_status,
    });
  }

  const now = new Date();
  const updates: Partial<typeof nbfcLspAgreements.$inferInsert> = {
    agreement_status: payload.agreement_status,
    updated_at: now,
  };

  // Capture the incoming Digio event in the audit jsonb regardless of status.
  const existing = (row.last_webhook_payload as Record<string, unknown>) ?? {};
  updates.last_webhook_payload = { ...existing, last_event: payload };

  let backfillNbfc = false;

  if (payload.agreement_status === "COMPLETED") {
    // Fetch signed PDF + audit trail (stubbed in test mode). Per the BRD,
    // these MUST be in place before the status persists; we run the fetch
    // and merge the URLs into the same UPDATE so it's all-or-nothing.
    const fetched = await fetchSignedLspPdfAndAuditTrail({
      agreementRowId: row.id,
      nbfcId: row.nbfc_id,
      digioDocumentId: row.digio_document_id ?? row.digio_request_id ?? "",
    }).catch((err) => {
      console.error("[E-008] fetchSignedLspPdf failed", err);
      return { signedPdfUrl: null, auditTrailUrl: null, stubbed: false };
    });

    // Prefer URLs explicitly carried by the webhook payload; fall back to
    // the fetched/stub URLs. Idempotency guarantees we only land here once.
    const signedUrl = payload.signed_document_url ?? fetched.signedPdfUrl;
    const auditUrl = payload.audit_trail_url ?? fetched.auditTrailUrl;
    if (signedUrl) updates.signed_pdf_url = signedUrl;
    if (auditUrl) updates.audit_trail_url = auditUrl;
    // signing_date is a DATE — store today's ISO date.
    updates.signing_date = now.toISOString().slice(0, 10);
    updates.completed_at = now;
    backfillNbfc = true;
  }

  await db
    .update(nbfcLspAgreements)
    .set(updates)
    .where(eq(nbfcLspAgreements.id, row.id));

  if (backfillNbfc) {
    // Backfill nbfc.lsp_agreement_id — guarded so we never overwrite a
    // previously-set pointer (idempotent across COMPLETED replays even if
    // the status guard above were ever loosened).
    await db
      .update(nbfc)
      .set({ lsp_agreement_id: row.id, updated_at: now })
      .where(eq(nbfc.id, row.nbfc_id));
  }

  return NextResponse.json({
    ok: true,
    agreement_id: row.agreement_id,
    agreement_status: payload.agreement_status,
    backfilled_nbfc_lsp_agreement_id: backfillNbfc,
  });
}
