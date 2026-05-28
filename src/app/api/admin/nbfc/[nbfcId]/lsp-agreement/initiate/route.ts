/**
 * E-007 (re-scoped under E-110) — POST
 * /api/admin/nbfc/{nbfcId}/lsp-agreement/initiate
 *
 * Step 3 "Send to CEO for Verification". Persists the agreement bundle
 * (parent + N signer rows + uploaded blank template PDF URL) and
 * transitions the NBFC into `pending_admin_review` so the CEO can review.
 *
 * Digio is intentionally NOT called here anymore — the actual signing
 * request happens after the CEO approves on Step 4. agreement_status is
 * set to 'PENDING_CEO_VERIFICATION' so the CEO panel can find these rows.
 *
 * agreement_id keeps the AGR-NBFC-YYYYMMDD-NNNN pattern; expires_at honors
 * server-side `NBFC_LSP_EXPIRE_IN_DAYS` (default 5) for downstream Digio
 * scheduling.
 *
 * Auth: shared admin / test-bypass idiom (same as E-001 / E-107).
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  nbfc,
  nbfcLspAgreements,
  nbfcLspAgreementSigners,
  nbfcStatusHistory,
} from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";
import {
  AGREEMENT_INITIATE_ALLOWED_NBFC_STATUSES,
  generateAgreementId,
  resolveLspExpireInDays,
} from "@/lib/nbfc/admin/lsp-agreement-initiate";
import { validateTransition } from "@/lib/nbfc/admin/status-transitions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Walk the .cause chain of an unknown error and surface the underlying
 * Postgres error (with SQLSTATE code, constraint, etc.) when present.
 * Drizzle wraps pg errors so `err.message` only carries the "Failed query:
 * <SQL> params: <params>" wrapper — the actual reason ("column ... does not
 * exist", "violates not-null constraint", etc.) is on `err.cause`.
 */
interface PgErrorLike {
  code?: string;
  message?: string;
  detail?: string;
  hint?: string;
  schema?: string;
  table?: string;
  column?: string;
  constraint?: string;
}

function extractPgError(err: unknown): {
  driverMessage: string;
  pg: PgErrorLike | null;
} {
  const driverMessage = err instanceof Error ? err.message : String(err);
  let cause: unknown = err;
  for (let i = 0; i < 5 && cause; i++) {
    if (cause && typeof cause === "object" && "code" in cause) {
      return { driverMessage, pg: cause as PgErrorLike };
    }
    cause = (cause as { cause?: unknown })?.cause;
  }
  return { driverMessage, pg: null };
}

const SignerSchema = z.object({
  fullName: z.string().min(2).max(200),
  email: z.string().email().max(200),
  designation: z.string().min(2).max(120),
  identityDocumentUrl: z.string().min(1).max(1024),
  identityDocumentSize: z.number().int().positive().optional(),
});

const InitiateBody = z.object({
  nbfcSigners: z.array(SignerSchema).min(1),
  itarangSigners: z.array(SignerSchema).min(1),
  agreementTemplateUrl: z.string().min(1).max(1024),
  agreementTemplateSize: z.number().int().positive().optional(),
});

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ nbfcId: string }> },
) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;
  const adminUserId = auth.user.id;

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

  // Pre-compute timing fields. Digio is NOT called at Step 3 anymore — these
  // values are persisted for the CEO approval step to consume when it
  // actually triggers Digio.
  const expireInDays = resolveLspExpireInDays();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + expireInDays * 24 * 60 * 60 * 1000);

  // Insert agreement parent row + child signer rows in a single transaction.
  // The legacy nbfc_signatory_* / itarang_signatory_*_* columns on the parent
  // are intentionally left NULL — E-109 child table is the new source of
  // truth for signer details. agreement_status is PENDING_CEO_VERIFICATION
  // until the CEO approves and the Digio call fires. Retry once on
  // agreement_id unique collision.
  let inserted: typeof nbfcLspAgreements.$inferSelect | undefined;
  for (let attempt = 0; attempt < 2 && !inserted; attempt += 1) {
    const agreementId = await generateAgreementId(db, now);
    try {
      inserted = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(nbfcLspAgreements)
          .values({
            agreement_id: agreementId,
            nbfc_id: nbfcRow.id,
            agreement_status: "PENDING_CEO_VERIFICATION",
            agreement_template_url: body.agreementTemplateUrl,
            agreement_template_size: body.agreementTemplateSize ?? null,
            expires_at: expiresAt,
          })
          .returning();

        // Propagate the FK so computeNbfcProgress sees Documents + Agreement
        // as done and pushes activeStep to "approval" on /approval, /review,
        // and the drafts list. Without this the stepper sticks on Documents.
        await tx
          .update(nbfc)
          .set({ lsp_agreement_id: row.id, updated_at: now })
          .where(eq(nbfc.id, nbfcRow.id));

        const signerRows = [
          ...body.nbfcSigners.map((s, i) => ({
            nbfc_lsp_agreement_id: row.id,
            signer_order: i + 1,
            party: "nbfc" as const,
            full_name: s.fullName,
            email: s.email,
            designation: s.designation,
            identity_document_url: s.identityDocumentUrl,
            identity_document_size: s.identityDocumentSize ?? null,
          })),
          ...body.itarangSigners.map((s, i) => ({
            nbfc_lsp_agreement_id: row.id,
            signer_order: body.nbfcSigners.length + i + 1,
            party: "itarang" as const,
            full_name: s.fullName,
            email: s.email,
            designation: s.designation,
            identity_document_url: s.identityDocumentUrl,
            identity_document_size: s.identityDocumentSize ?? null,
          })),
        ];
        await tx.insert(nbfcLspAgreementSigners).values(signerRows);

        return row;
      });
    } catch (err) {
      const { driverMessage, pg } = extractPgError(err);

      // Log the full structured error server-side so the dev terminal carries
      // the Postgres reason even when the JSON response is truncated in the
      // client UI.
      console.error("[lsp-agreement/initiate] persist failed", {
        driverMessage,
        pg,
        err,
      });

      // Retry path for agreement_id unique collisions (rare). Match via
      // SQLSTATE 23505 + constraint name rather than regex on the wrapper.
      const isAgreementIdUnique =
        pg?.code === "23505" &&
        (pg.constraint?.includes("agreement_id") ||
          /agreement_id/i.test(pg.message ?? "") ||
          /agreement_id/i.test(driverMessage));
      if (isAgreementIdUnique) {
        if (attempt === 1) {
          return NextResponse.json(
            {
              ok: false,
              error: "AGREEMENT_ID_COLLISION",
              reason: pg?.message ?? driverMessage,
              pg,
              driverMessage,
            },
            { status: 503 },
          );
        }
        continue;
      }

      // Generic persist failure — surface the Postgres reason.
      const reason = pg?.message ?? driverMessage;
      return NextResponse.json(
        {
          ok: false,
          error: "PERSIST_FAILED",
          reason,
          pg: pg
            ? {
                code: pg.code,
                message: pg.message,
                detail: pg.detail,
                hint: pg.hint,
                table: pg.table,
                column: pg.column,
                constraint: pg.constraint,
              }
            : null,
          driverMessage,
        },
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

  // With the Step 2.5 CEO doc-verification gate removed, the LSP initiate
  // step is where the NBFC leaves `draft` and enters the CEO approval queue.
  // Best-effort: skip silently if status was already past draft, or if the
  // transition fails for any reason (the agreement row already exists).
  if (nbfcRow.status === "draft") {
    const reason = "Agreement sent to CEO for verification";
    const guard = validateTransition({
      from: nbfcRow.status,
      to: "pending_admin_review",
      reason,
    });
    if (guard.ok) {
      try {
        await db
          .update(nbfc)
          .set({ status: "pending_admin_review", updated_at: now })
          .where(eq(nbfc.id, nbfcRow.id));
        await db.insert(nbfcStatusHistory).values({
          nbfc_id: nbfcRow.id,
          from_status: guard.from,
          to_status: guard.to,
          actor_id: adminUserId,
          reason,
          occurred_at: now,
        });
      } catch {
        /* non-blocking: the agreement row is already persisted */
      }
    }
  }

  const totalSigners = body.nbfcSigners.length + body.itarangSigners.length;
  return NextResponse.json({
    ok: true,
    id: inserted.id,
    agreementId: inserted.agreement_id,
    agreementStatus: inserted.agreement_status,
    agreementTemplateUrl: inserted.agreement_template_url,
    expiresAt: inserted.expires_at?.toISOString?.() ?? null,
    signerCount: totalSigners,
    expireInDays,
  });
}
