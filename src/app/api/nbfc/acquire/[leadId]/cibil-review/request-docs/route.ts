/**
 * POST /api/nbfc/acquire/[leadId]/cibil-review/request-docs
 *   body { items: [{ doc_label, reason?, is_required? }] (1–10), comments?, doc_for? }
 *
 * E-389 — the approver asks for additional documents BEFORE deciding a pending
 * CIBIL report (Battery Pool diagram 3). The request goes to the iTarang admin
 * like every NBFC document request (forward → WhatsApp → upload → admin verify →
 * pushed back); the review stays pending and the verifier stays locked.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { clientError } from "@/lib/nbfc/http-error";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { requestCibilDocs } from "@/lib/nbfc/cibil-review";
import { STEP4_MAX_ITEMS } from "@/lib/nbfc/doc-requests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  if (msg.startsWith("CONFLICT")) return 409;
  return 500;
}

const Body = z.object({
  items: z
    .array(
      z.object({
        doc_label: z.string().trim().min(1).max(200),
        reason: z.string().trim().max(2000).optional().nullable(),
        is_required: z.boolean().optional(),
      }),
    )
    .min(1, "pick at least one document")
    .max(STEP4_MAX_ITEMS),
  comments: z.string().trim().max(4000).optional().nullable(),
  doc_for: z.enum(["primary", "co_borrower"]).default("primary"),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: `BAD_REQUEST: ${parsed.error.issues[0]?.message ?? "invalid input"}` },
        { status: 400 },
      );
    }
    const actor = await resolveActor(req.headers);
    const result = await requestCibilDocs({
      actor,
      leadId,
      items: parsed.data.items,
      comments: parsed.data.comments ?? null,
      docFor: parsed.data.doc_for,
      req,
    });
    return NextResponse.json({ ok: true, ...result, routed_to: "admin" });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
