// ID 183 — the dealer's "Ask iTarang to help" on one of his customer files.
//
//   GET    → is an ask open on this file?
//   POST   { note? } → open one (Admin / Sales Head may then act for him at
//            once, instead of waiting 1 working day with no dealer action).
//   DELETE → withdraw it.
//
// The file's own dealer only (never the house, never staff). Stored in
// lead_assist_requests (E-345); without that table the toggle says so.
// iTarang is told by a bell to Admin / Sales Head.

import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { leads } from "@/lib/db/schema";
import { requireRole } from "@/lib/auth-utils";
import { dealerMayDispatch } from "@/lib/auth/requireLeadAccess";
import { emit } from "@/lib/notifications/emit";
import { dealerParty } from "@/lib/notifications/provenance";
import { dealerDisplayNames } from "@/lib/leads/pushGuards";

export const dynamic = "force-dynamic";

const NOT_SET_UP = "Asking iTarang for help is not set up on this system yet.";

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status });

async function gate(leadId: string) {
  const user = await requireRole(["dealer"]);
  const [lead] = await db
    .select({ id: leads.id, dealerId: leads.dealer_id, name: leads.full_name, owner: leads.owner_name, ref: leads.reference_id })
    .from(leads)
    .where(eq(leads.id, leadId))
    .limit(1);
  // Only the dealer the file belongs to may ask (dealerMayDispatch = owner only).
  if (!lead || !(await dealerMayDispatch(user, lead.dealerId))) return null;
  return { user, lead };
}

async function openAsk(leadId: string): Promise<{ requestedAt: string; by: string | null } | null> {
  const rows = (await db.execute(sql`
    SELECT requested_at, requested_by_name FROM lead_assist_requests
     WHERE lead_id = ${leadId} AND withdrawn_at IS NULL
     ORDER BY requested_at DESC LIMIT 1
  `)) as unknown as Array<{ requested_at: Date | string; requested_by_name: string | null }>;
  const r = rows[0];
  return r ? { requestedAt: new Date(r.requested_at).toISOString(), by: r.requested_by_name } : null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate((await params).id);
  if (!g) return json({ success: false, error: { message: "Access denied" } }, 403);
  try {
    return json({ success: true, data: { open: await openAsk(g.lead.id) } });
  } catch (err) {
    console.error("[assist-request] read failed (is E-345 applied?):", err);
    return json({ success: true, data: { open: null, unavailable: NOT_SET_UP } });
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate((await params).id);
  if (!g) return json({ success: false, error: { message: "Access denied" } }, 403);
  const body = (await req.json().catch(() => ({}))) as { note?: unknown };
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) || null : null;
  try {
    await db.execute(sql`
      INSERT INTO lead_assist_requests (lead_id, dealer_code, requested_by, requested_by_name, note)
      VALUES (${g.lead.id}, ${g.lead.dealerId}, ${g.user.id}::uuid, ${g.user.name ?? null}, ${note})
      ON CONFLICT (lead_id) WHERE withdrawn_at IS NULL DO NOTHING
    `);
  } catch (err) {
    console.error("[assist-request] write failed (is E-345 applied?):", err);
    return json({ success: false, error: { message: NOT_SET_UP } }, 503);
  }
  const dealer = (await dealerDisplayNames(g.lead.dealerId ? [g.lead.dealerId] : [])).get(g.lead.dealerId ?? "") ?? "A dealer";
  const customer = g.lead.name || g.lead.owner || "a customer";
  await emit({
    type: "lead.assist_requested",
    title: `${dealer} asked iTarang to help`,
    message: `${dealer} asked iTarang to help on ${customer}'s file (${g.lead.ref ?? g.lead.id})${note ? ` — ${note}` : ""}. Open it to act for the dealer.`,
    leadId: g.lead.id,
    from: dealerParty(dealer),
    to: [{ audience: { kind: "roles", roles: ["admin", "sales_head"] }, as: { party: "admin", label: "iTarang Admin" }, href: `/admin/kyc-review/${encodeURIComponent(g.lead.id)}` }],
  });
  return json({ success: true, data: { open: await openAsk(g.lead.id).catch(() => null) } });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const g = await gate((await params).id);
  if (!g) return json({ success: false, error: { message: "Access denied" } }, 403);
  try {
    await db.execute(sql`
      UPDATE lead_assist_requests SET withdrawn_at = now(), withdrawn_by = ${g.user.id}::uuid
       WHERE lead_id = ${g.lead.id} AND withdrawn_at IS NULL
    `);
  } catch (err) {
    console.error("[assist-request] withdraw failed (is E-345 applied?):", err);
    return json({ success: false, error: { message: NOT_SET_UP } }, 503);
  }
  return json({ success: true, data: { open: null } });
}
