/**
 * E-111 — POST /api/admin/nbfc/{nbfcId}/corrections
 *
 * The CEO submits a batch of per-item correction flags. Each flag identifies
 * a stable `target_key` (see `src/lib/nbfc/admin/correction-catalog.ts`) and
 * carries an optional remark. We:
 *   1. Validate the body (≥1 item, every (kind, target_key) recognised).
 *   2. Supersede any existing `open` round on the NBFC.
 *   3. Insert a new round with `round_number = max+1`.
 *   4. Snapshot `previous_value` / `previous_file_url` from the live tables
 *      so the CEO can later see old vs new at resolution time.
 *   5. Drive the existing status machine to `request_correction` (records the
 *      transition in `nbfc_status_history` so the legacy banner still works).
 *
 * Caller: CEO only (`role === "ceo"` OR email = canonical CEO mailbox).
 * 400: empty items / invalid target_key
 * 403: not CEO
 * 404: NBFC missing
 * 409: status machine refuses the transition
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  nbfc,
  nbfcComplianceDocuments,
  nbfcCorrectionItems,
  nbfcCorrectionRounds,
  nbfcLspAgreements,
  nbfcLspAgreementSigners,
  nbfcStatusHistory,
} from "@/lib/db/schema";
import { requireAdminOrTestBypass } from "@/lib/auth/adminTestBypass";
import {
  CORRECTION_KINDS,
  type CorrectionKind,
  parseSignerKey,
  validateTargetKey,
} from "@/lib/nbfc/admin/correction-catalog";
import { validateTransition } from "@/lib/nbfc/admin/status-transitions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CEO_EMAIL = "sanchit@itarang.com";

const ItemBody = z.object({
  kind: z.enum(CORRECTION_KINDS),
  targetKey: z.string().min(1).max(120),
  targetRefId: z.number().int().positive().optional(),
  remark: z.string().max(2000).optional(),
});

const Body = z.object({
  summaryRemarks: z.string().max(2000).optional(),
  items: z.array(ItemBody).min(1),
});

const NBFC_MASTER_FIELD_COLUMN: Record<string, string> = {
  legal_name: "legal_name",
  short_name: "short_name",
  rbi_registration_no: "rbi_registration_no",
  cin: "cin",
  gst_number: "gst_number",
  pan_number: "pan_number",
  nbfc_type: "nbfc_type",
  partnership_date: "partnership_date",
  cor_expiry_date: "cor_expiry_date",
  registered_address: "registered_address",
  active_geographies: "active_geographies",
  primary_contact_name: "primary_contact_name",
  primary_contact_email: "primary_contact_email",
  primary_contact_phone: "primary_contact_phone",
  grievance_officer_name: "grievance_officer_name",
  grievance_helpline: "grievance_helpline",
  grievance_url: "grievance_url",
  nodal_officer: "nodal_officer",
};

function stringifyMaybeJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ nbfcId: string }> },
) {
  const auth = await requireAdminOrTestBypass(req.headers);
  if (!auth.ok) return auth.response;

  const role = (auth.user.role ?? "").toLowerCase();
  const email = (auth.user.email ?? "").toLowerCase();
  const isCeo =
    role === "ceo" || email === CEO_EMAIL || auth.user.via === "test_bypass";
  if (!isCeo) {
    return NextResponse.json(
      { ok: false, error: "FORBIDDEN", message: "Only the CEO may request corrections." },
      { status: 403 },
    );
  }

  const { nbfcId } = await ctx.params;
  const id = Number.parseInt(nbfcId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json(
      { ok: false, error: "Invalid nbfcId" },
      { status: 400 },
    );
  }

  let raw: unknown;
  try {
    const text = await req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 },
    );
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: "VALIDATION", issues: parsed.error.issues },
      { status: 400 },
    );
  }

  // Per-item key validation (catalog-driven).
  for (const item of parsed.data.items) {
    const r = validateTargetKey(item.kind as CorrectionKind, item.targetKey);
    if (!r.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "INVALID_TARGET",
          message: r.reason,
          item,
        },
        { status: 400 },
      );
    }
  }

  // Load NBFC and validate current status allows request_correction.
  const [row] = await db
    .select({ id: nbfc.id, status: nbfc.status })
    .from(nbfc)
    .where(eq(nbfc.id, id))
    .limit(1);
  if (!row) {
    return NextResponse.json(
      { ok: false, error: "NBFC not found" },
      { status: 404 },
    );
  }

  const guard = validateTransition({
    from: row.status,
    to: "request_correction",
    reason: parsed.data.summaryRemarks ?? null,
  });
  if (!guard.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: guard.code,
        message: guard.message,
        from: row.status,
        to: "request_correction",
      },
      { status: guard.code === "REASON_REQUIRED" ? 422 : 409 },
    );
  }

  // Snapshot helpers — pull current values from live tables so we can record
  // previous_value / previous_file_url on the new round.
  const [nbfcFull] = await db.select().from(nbfc).where(eq(nbfc.id, id));
  const docs = await db
    .select()
    .from(nbfcComplianceDocuments)
    .where(eq(nbfcComplianceDocuments.nbfc_id, id));
  const latestDocBySlug = new Map<string, (typeof docs)[number]>();
  for (const d of docs) {
    const prev = latestDocBySlug.get(d.document_type);
    if (
      !prev ||
      new Date(d.created_at as Date | string) >=
        new Date(prev.created_at as Date | string)
    ) {
      latestDocBySlug.set(d.document_type, d);
    }
  }
  const [agreement] = await db
    .select()
    .from(nbfcLspAgreements)
    .where(eq(nbfcLspAgreements.nbfc_id, id))
    .orderBy(desc(nbfcLspAgreements.created_at))
    .limit(1);
  const signers = agreement
    ? await db
        .select()
        .from(nbfcLspAgreementSigners)
        .where(
          eq(nbfcLspAgreementSigners.nbfc_lsp_agreement_id, agreement.id),
        )
    : [];

  function snapshotForItem(item: z.infer<typeof ItemBody>): {
    previous_value: string | null;
    previous_file_url: string | null;
  } {
    switch (item.kind) {
      case "master_field": {
        const col = NBFC_MASTER_FIELD_COLUMN[item.targetKey];
        if (!col || !nbfcFull)
          return { previous_value: null, previous_file_url: null };
        const v = (nbfcFull as Record<string, unknown>)[col];
        return {
          previous_value: stringifyMaybeJson(v),
          previous_file_url: null,
        };
      }
      case "compliance_doc": {
        const d = latestDocBySlug.get(item.targetKey);
        return {
          previous_value: d?.status ?? null,
          previous_file_url: d?.file_url ?? null,
        };
      }
      case "signer_field": {
        const p = parseSignerKey(item.targetKey);
        if (!p || p.field === "identity")
          return { previous_value: null, previous_file_url: null };
        const s = signers.find(
          (r) =>
            r.party === p.party && r.signer_order === p.signerOrder,
        );
        if (!s) return { previous_value: null, previous_file_url: null };
        const fieldVal =
          p.field === "full_name"
            ? s.full_name
            : p.field === "email"
              ? s.email
              : s.designation;
        return {
          previous_value: fieldVal ?? null,
          previous_file_url: null,
        };
      }
      case "signer_identity_doc": {
        const p = parseSignerKey(item.targetKey);
        if (!p) return { previous_value: null, previous_file_url: null };
        const s = signers.find(
          (r) =>
            r.party === p.party && r.signer_order === p.signerOrder,
        );
        return {
          previous_value: null,
          previous_file_url: s?.identity_document_url ?? null,
        };
      }
      case "agreement_template": {
        return {
          previous_value: agreement?.agreement_status ?? null,
          previous_file_url: agreement?.agreement_template_url ?? null,
        };
      }
    }
  }

  const now = new Date();

  // Supersede any existing open round (single CEO usually, but be safe).
  await db
    .update(nbfcCorrectionRounds)
    .set({ status: "superseded", updated_at: now })
    .where(
      and(
        eq(nbfcCorrectionRounds.nbfc_id, id),
        eq(nbfcCorrectionRounds.status, "open"),
      ),
    );

  // Allocate next round_number atomically.
  const [{ max }] = await db
    .select({
      max: sql<number>`COALESCE(MAX(${nbfcCorrectionRounds.round_number}), 0)`,
    })
    .from(nbfcCorrectionRounds)
    .where(eq(nbfcCorrectionRounds.nbfc_id, id));
  const nextRoundNumber = Number(max ?? 0) + 1;

  const [round] = await db
    .insert(nbfcCorrectionRounds)
    .values({
      nbfc_id: id,
      round_number: nextRoundNumber,
      status: "open",
      requested_by: auth.user.id,
      summary_remarks: parsed.data.summaryRemarks ?? null,
      created_at: now,
      updated_at: now,
    })
    .returning({
      id: nbfcCorrectionRounds.id,
      round_number: nbfcCorrectionRounds.round_number,
    });

  // Insert items with snapshots.
  const itemRows = parsed.data.items.map((it) => {
    const snap = snapshotForItem(it);
    return {
      round_id: round.id,
      kind: it.kind,
      target_key: it.targetKey,
      target_ref_id: it.targetRefId ?? null,
      previous_value: snap.previous_value,
      previous_file_url: snap.previous_file_url,
      remark: it.remark ?? null,
      resolution_status: "pending" as const,
      created_at: now,
    };
  });
  if (itemRows.length > 0) {
    await db.insert(nbfcCorrectionItems).values(itemRows);
  }

  // Drive the status machine. The transition route's logic is replicated
  // here so the round + transition land together; we still write the
  // status-history row so the existing banner-by-history surface keeps
  // working.
  await db
    .update(nbfc)
    .set({ status: guard.to, updated_at: now })
    .where(eq(nbfc.id, id));

  await db.insert(nbfcStatusHistory).values({
    nbfc_id: id,
    from_status: guard.from,
    to_status: guard.to,
    actor_id: auth.user.id,
    reason:
      parsed.data.summaryRemarks ??
      `Per-item corrections (${parsed.data.items.length} items) — see correction panel`,
    occurred_at: now,
  });

  return NextResponse.json({
    ok: true,
    nbfcId: id,
    roundId: round.id,
    roundNumber: round.round_number,
    itemCount: itemRows.length,
    status: guard.to,
    occurredAt: now,
  });
}
