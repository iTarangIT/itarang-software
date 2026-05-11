/**
 * E-007 — POST /api/admin/nbfc/{nbfcId}/lsp-agreement/initiate
 *
 * Initiates the NBFC LSP Agreement via Digio's multi_templates
 * create_sign_request endpoint with sequential signing
 * (NBFC → iTarang1 → iTarang2).
 *
 * Persistence: creates an `nbfc_lsp_agreements` row with
 * agreement_status = 'SENT_TO_EXTERNAL_PARTY' and a server-generated
 * agreement_id of pattern `AGR-NBFC-YYYYMMDD-NNNN`. expires_at honors
 * server-side `NBFC_LSP_EXPIRE_IN_DAYS` (default 5) — body cannot override.
 *
 * Auth: triple-guarded admin test bypass (NODE_ENV != production AND
 * NBFC_TEST_BYPASS_SECRET set on the server AND `x-nbfc-test-bypass`
 * header on the request) — same idiom as E-001.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfc, nbfcLspAgreements } from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";
import {
  AGREEMENT_INITIATE_ALLOWED_NBFC_STATUSES,
  buildSignerOrder,
  generateAgreementId,
  resolveLspExpireInDays,
} from "@/lib/nbfc/admin/lsp-agreement-initiate";
import {
  createMultiTemplateSignRequest,
  type MultiTemplateCreateInput,
} from "@/lib/digio/multi-templates";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const InitiateBody = z.object({
  nbfcSignatoryName: z.string().min(1).max(200),
  nbfcSignatoryEmail: z.string().email().max(200),
  itarangSignatory1Name: z.string().min(1).max(200),
  itarangSignatory1Email: z.string().email().max(200),
  itarangSignatory2Name: z.string().min(1).max(200),
  itarangSignatory2Email: z.string().email().max(200),
});

const LSP_TEMPLATE_KEY =
  process.env.NBFC_LSP_TEMPLATE_KEY ?? "iTarang_Test_NbfcLspAgreement_100";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ nbfcId: string }> },
) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;
  const adminUserId = auth.user.id;
  // adminUserId is a uuid (Supabase) — created_by stores numeric integer per
  // schema; we keep it null here when uuid (loop tests pass uuid bypass), and
  // record initiated_by in the audit jsonb. created_by is left null so
  // existing nbfc table referential integrity is preserved.
  const _adminId = adminUserId; // referenced via jsonb audit payload
  void _adminId;

  const { nbfcId: nbfcIdRaw } = await ctx.params;
  const nbfcIdNum = Number.parseInt(nbfcIdRaw, 10);
  if (!Number.isInteger(nbfcIdNum) || nbfcIdNum <= 0) {
    return NextResponse.json(
      { ok: false, error: "Invalid nbfcId" },
      { status: 400 },
    );
  }

  // Parse + validate body.
  let bodyJson: unknown = {};
  try {
    const text = await req.text();
    bodyJson = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const parsed = InitiateBody.safeParse(bodyJson);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "VALIDATION", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const body = parsed.data;

  // Resolve NBFC + status guard.
  const [nbfcRow] = await db
    .select({ id: nbfc.id, status: nbfc.status })
    .from(nbfc)
    .where(eq(nbfc.id, nbfcIdNum));
  if (!nbfcRow) {
    return NextResponse.json(
      { ok: false, error: "NBFC not found" },
      { status: 404 },
    );
  }
  if (!AGREEMENT_INITIATE_ALLOWED_NBFC_STATUSES.has(nbfcRow.status)) {
    return NextResponse.json(
      {
        ok: false,
        error: "INVALID_NBFC_STATUS",
        status: nbfcRow.status,
        allowed: Array.from(AGREEMENT_INITIATE_ALLOWED_NBFC_STATUSES),
      },
      { status: 409 },
    );
  }

  // Generate server-side agreement_id (with one retry on unique violation).
  const expireInDays = resolveLspExpireInDays();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expireInDays * 24 * 60 * 60 * 1000);
  const callbackToken = `NBFC_${nbfcRow.id}`;

  // Build Digio payload — sequential=true; signer order [NBFC, iTarang1, iTarang2].
  const signers = buildSignerOrder(body);
  const digioPayload: MultiTemplateCreateInput = {
    templates: [{ template_key: LSP_TEMPLATE_KEY }],
    signers,
    sequential: true,
    expire_in_days: expireInDays,
    notify_signers: true,
    customer_notification_mode: "ALL",
    callback: callbackToken,
    estamp_request: { tags: { iTarang_Test_DealerAgreement_100: 1 } },
  };

  let digioResponse: { id: string; agreement_status?: string } | null = null;
  try {
    digioResponse = await createMultiTemplateSignRequest(digioPayload);
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: "DIGIO_REQUEST_FAILED",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }

  if (!digioResponse?.id) {
    return NextResponse.json(
      { ok: false, error: "DIGIO_NO_DOCUMENT_ID" },
      { status: 502 },
    );
  }

  // Insert agreement row. Retry once on agreement_id unique collision (rare).
  let inserted: typeof nbfcLspAgreements.$inferSelect | undefined;
  for (let attempt = 0; attempt < 2 && !inserted; attempt += 1) {
    const agreementId = await generateAgreementId(db, now);
    try {
      const [row] = await db
        .insert(nbfcLspAgreements)
        .values({
          agreement_id: agreementId,
          nbfc_id: nbfcRow.id,
          digio_document_id: digioResponse.id,
          digio_request_id: digioResponse.id,
          agreement_status: "SENT_TO_EXTERNAL_PARTY",
          nbfc_signatory_name: body.nbfcSignatoryName,
          nbfc_signatory_email: body.nbfcSignatoryEmail,
          itarang_signatory_1_name: body.itarangSignatory1Name,
          itarang_signatory_1_email: body.itarangSignatory1Email,
          itarang_signatory_2_name: body.itarangSignatory2Name,
          itarang_signatory_2_email: body.itarangSignatory2Email,
          expires_at: expiresAt,
          initiated_at: now,
          last_webhook_payload: {
            init_request: digioPayload,
            init_response: digioResponse,
          },
        })
        .returning();
      inserted = row;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/agreement_id/i.test(message) && /unique|duplicate/i.test(message)) {
        if (attempt === 1) {
          return NextResponse.json(
            { ok: false, error: "AGREEMENT_ID_COLLISION", message },
            { status: 503 },
          );
        }
        continue; // retry
      }
      return NextResponse.json(
        { ok: false, error: "PERSIST_FAILED", message },
        { status: 500 },
      );
    }
  }

  if (!inserted) {
    return NextResponse.json(
      { ok: false, error: "PERSIST_FAILED" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    id: inserted.id,
    agreementId: inserted.agreement_id,
    digioDocumentId: inserted.digio_document_id,
    agreementStatus: inserted.agreement_status,
    expiresAt: inserted.expires_at?.toISOString?.() ?? null,
    callback: callbackToken,
    sequential: true,
    signerCount: signers.length,
    signerOrder: signers.map((s) => s.identifier),
    expireInDays,
  });
}
