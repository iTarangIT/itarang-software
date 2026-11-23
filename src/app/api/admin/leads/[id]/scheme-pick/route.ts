/**
 * GET/POST /api/admin/leads/[id]/scheme-pick — E-393 (23 Nov 2026, Battery Pool).
 *
 * The iTarang admin / sales head chooses the NBFC scheme (lender + loan
 * product) before the lead goes to a lender. The pick beats the NBFC routing
 * rules when Step 4 opens (resolveRoutingTarget), as long as the BRE still
 * allows it. The WhatsApp equivalent lives in src/lib/whatsapp/intake-loan-flow.ts.
 *
 *   GET  → { current, options, locked, can_pick }
 *   POST { nbfc_id, loan_product_id } | { clear: true }
 */
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { nbfcLeadAssignments } from "@/lib/db/schema";
import { requireAdminAppUserForLead } from "@/lib/kyc/admin-workflow";
import {
  SchemePickError,
  getLeadSchemePick,
  listSchemeOptions,
  mayPickScheme,
  setLeadSchemePick,
} from "@/lib/leads/scheme-pick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function withLender(leadId: string): Promise<boolean> {
  const [a] = await db
    .select({ id: nbfcLeadAssignments.id })
    .from(nbfcLeadAssignments)
    .where(eq(nbfcLeadAssignments.lead_id, leadId))
    .limit(1);
  return !!a;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await params;
  const user = await requireAdminAppUserForLead(leadId);
  if (!user) return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  try {
    const [current, options, locked] = await Promise.all([
      getLeadSchemePick(leadId),
      listSchemeOptions(leadId),
      withLender(leadId),
    ]);
    const hit = current
      ? options.find((o) => o.nbfcId === current.nbfc_id && o.loanProductId === current.loan_product_id)
      : null;
    return NextResponse.json({
      ok: true,
      current: current
        ? {
            nbfc_id: current.nbfc_id,
            loan_product_id: current.loan_product_id,
            label: hit?.label ?? `NBFC #${current.nbfc_id} — product #${current.loan_product_id}`,
            still_eligible: !!hit,
            picked_by_name: current.picked_by_name,
            picked_at: current.picked_at.toISOString(),
            channel: current.channel,
          }
        : null,
      options,
      locked,
      can_pick: mayPickScheme(user.role) && !locked,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A DB without E-393 has no lead_scheme_picks table.
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

const Body = z.union([
  z.object({ clear: z.literal(true) }),
  z.object({ nbfc_id: z.coerce.number().int().positive(), loan_product_id: z.coerce.number().int().positive() }),
]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: leadId } = await params;
  const user = await requireAdminAppUserForLead(leadId);
  if (!user || !mayPickScheme(user.role)) {
    return NextResponse.json({ ok: false, error: "Only an admin or sales head can choose the scheme" }, { status: 403 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ ok: false, error: "Pick a scheme" }, { status: 400 });
  if (await withLender(leadId)) {
    return NextResponse.json(
      { ok: false, error: "The file is already with a lender — the scheme can no longer be changed here" },
      { status: 409 },
    );
  }
  try {
    const r = await setLeadSchemePick({
      leadId,
      pick: "clear" in parsed.data ? null : { nbfcId: parsed.data.nbfc_id, loanProductId: parsed.data.loan_product_id },
      byUserId: user.id,
      byName: user.name ?? user.email ?? null,
      channel: "web",
    });
    // Step 4 may already be open with no lender yet — route now.
    if (r.label) {
      void import("@/lib/leads/nbfc-routing")
        .then((m) => m.autoRouteLead(leadId, { trigger: "scheme_pick" }))
        .catch(() => {});
    }
    return NextResponse.json({ ok: true, label: r.label });
  } catch (e) {
    if (e instanceof SchemePickError) return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
