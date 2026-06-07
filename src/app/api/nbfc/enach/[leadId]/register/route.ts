/**
 * POST /api/nbfc/enach/[leadId]/register
 *
 * BRD Addendum V0.2 §9 — fires the Model B2-B E-NACH handoff to the WINNING
 * NBFC's own application (redirect deep-link OR webhook, per the NBFC's config)
 * and records a new in_progress attempt. iTarang sends NO bank details and NO
 * credentials (§9.5) — mandate registration is entirely the NBFC's job.
 *
 * Role: `operations` (owns VKYC + E-NACH initiation, §7.2) or `nbfc_admin`.
 * Retries are unlimited (§9.4) — each call inserts a fresh row.
 */
import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  enachMandates,
  leads,
  loanSanctions,
  nbfcServiceConfig,
  productSelections,
} from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { generateEnachRef, getWinningAssignment } from "@/lib/nbfc/enach";
import { assertNotHaltedByFailure } from "@/lib/nbfc/track-gate";
import { publicOrigin, PublicOriginError } from "@/lib/public-origin";
import { createEmandateCustomer, createEmandateOrder, razorpayErrorMessage } from "@/lib/razorpay";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
  try {
    const { leadId } = await params;
    const actor = await resolveActor(req.headers);
    if (actor.role !== "operations" && actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' cannot trigger E-NACH; operations or nbfc_admin required` },
        { status: 403 },
      );
    }

    // E-NACH is winner-only (§9.1). The selected assignment must be this tenant's.
    const winner = await getWinningAssignment(leadId);
    if (!winner) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: no winning NBFC selected for this lead yet" },
        { status: 400 },
      );
    }
    if (winner.tenant_id !== actor.tenant_id) {
      return NextResponse.json(
        { ok: false, error: "FORBIDDEN: lead's winning NBFC is a different tenant" },
        { status: 403 },
      );
    }

    // Read the per-lead config snapshot (§7.4) — falls back to live config for
    // legacy rows created before snapshots existed.
    let snap = (winner.snapshot ?? null) as { enach_enabled?: boolean } | null;
    if (!snap) {
      const cfg = await db
        .select({ enach_enabled: nbfcServiceConfig.enach_enabled })
        .from(nbfcServiceConfig)
        .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
        .limit(1);
      snap = cfg[0] ?? { enach_enabled: false };
    }
    if (!snap.enach_enabled) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: E-NACH is not opted in for this lead's NBFC" },
        { status: 400 },
      );
    }

    // §7.4 Track Rules — if a sibling track (FI/VKYC) has failed and this NBFC
    // halts the others on failure, the E-NACH trigger must not fire. (An E-NACH
    // retry after its OWN failure stays allowed — §9.4 unlimited retries.)
    await assertNotHaltedByFailure(leadId, "enach");

    // Live config carries the handoff method + endpoint (operational routing,
    // not a per-lead behavioural toggle, so live is correct here).
    const cfgRows = await db
      .select({
        method: nbfcServiceConfig.enach_handoff_method,
        endpoint: nbfcServiceConfig.enach_endpoint_url,
      })
      .from(nbfcServiceConfig)
      .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
      .limit(1);
    const method = cfgRows[0]?.method ?? null;
    const endpoint = cfgRows[0]?.endpoint ?? null;
    if (!method) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: E-NACH handoff method not configured in Settings" },
        { status: 400 },
      );
    }
    // The B2-B modes hand off to the NBFC's own app and need its endpoint; the
    // managed Razorpay mode owns the rail itself, so no endpoint is required.
    if ((method === "redirect" || method === "webhook") && !endpoint) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: E-NACH endpoint URL not configured in Settings" },
        { status: 400 },
      );
    }

    let origin: string;
    try {
      origin = publicOrigin({ req });
    } catch (err) {
      const msg = err instanceof PublicOriginError ? err.message : "Cannot determine public origin";
      return NextResponse.json({ ok: false, error: `Server misconfig: ${msg}` }, { status: 500 });
    }

    // Customer + financing context for the outbound payload (§9.5). NO bank
    // details, NO credentials — those are the NBFC's to collect.
    const [lead] = await db
      .select({
        name: leads.full_name,
        owner_name: leads.owner_name,
        phone: leads.phone,
        owner_contact: leads.owner_contact,
        mobile: leads.mobile,
        owner_email: leads.owner_email,
      })
      .from(leads)
      .where(eq(leads.id, leadId))
      .limit(1);
    if (!lead) {
      return NextResponse.json({ ok: false, error: "NOT_FOUND: lead not found" }, { status: 404 });
    }
    const phone = (lead.phone || lead.owner_contact || lead.mobile || "").toString().replace(/\D/g, "").slice(-10);
    const customerName = (lead.name || lead.owner_name || "").toString();
    const customerEmail = (lead.owner_email || "").toString().trim() || null;

    const [sanction] = await db
      .select({ loan_amount: loanSanctions.loan_amount, emi: loanSanctions.emi, tenure: loanSanctions.tenure_months })
      .from(loanSanctions)
      .where(eq(loanSanctions.lead_id, leadId))
      .orderBy(desc(loanSanctions.created_at))
      .limit(1);
    const [ps] = await db
      .select({ final_price: productSelections.final_price })
      .from(productSelections)
      .where(and(eq(productSelections.lead_id, leadId), eq(productSelections.payment_mode, "finance")))
      .orderBy(desc(productSelections.created_at))
      .limit(1);

    const enachRef = generateEnachRef(leadId);
    const callbackUrl = `${origin}/api/nbfc/enach/callback`;

    // ── Managed Razorpay variant (E-145) ──────────────────────────────────
    // iTarang creates + tracks the e-mandate itself via Razorpay Orders+Tokens.
    // The customer authorises through Razorpay Checkout (returned below); the
    // signature-verified webhook flips status to registered/failed. Distinct
    // from the B2-B modes which hand off to the NBFC's own app.
    if (method === "itarang_razorpay") {
      // Per-debit ceiling: EMI (×1.5 headroom) else loan amount, in paise.
      const emiRupees = Number(sanction?.emi ?? 0);
      const loanRupees = Number(sanction?.loan_amount ?? ps?.final_price ?? 0);
      const baseRupees = emiRupees > 0 ? emiRupees * 1.5 : loanRupees || 100000;
      const maxAmountPaise = Math.min(
        Math.round(baseRupees * 100),
        100_00_00_000, // ₹1,00,00,000 hard cap
      );

      let checkout;
      try {
        const customer = await createEmandateCustomer({
          name: customerName || "Customer",
          email: customerEmail,
          contact: phone || undefined,
          notes: { itarang_lead_id: leadId, itarang_enach_ref: enachRef },
        });
        const order = await createEmandateOrder({
          customerId: customer.id,
          maxAmountPaise,
          enachRef,
          leadId,
          nbfcId: winner.nbfc_id,
          bankAccountName: customerName || undefined,
        });
        checkout = {
          order_id: order.order_id,
          key_id: order.key_id,
          customer_id: order.customer_id,
          amount: order.amount,
          currency: order.currency,
          name: customerName,
          email: customerEmail,
          contact: phone,
        };

        const now = new Date();
        const [mandate] = await db
          .insert(enachMandates)
          .values({
            lead_id: leadId,
            nbfc_id: winner.nbfc_id,
            tenant_id: actor.tenant_id,
            enach_ref: enachRef,
            status: "in_progress",
            provider_name: "razorpay",
            provider_raw_status: "order_created",
            registration_method: "razorpay",
            razorpay_order_id: order.order_id,
            razorpay_customer_id: order.customer_id,
            max_amount: (maxAmountPaise / 100).toFixed(2),
            registration_date: now,
            triggered_by: actor.user_id,
            triggered_at: now,
            updated_at: now,
          })
          .returning({ id: enachMandates.id });

        return NextResponse.json({
          ok: true,
          mandate_id: mandate.id,
          enach_ref: enachRef,
          handoff: { method, checkout },
        });
      } catch (err) {
        // Razorpay rejects with a non-Error object — unwrap so the real reason
        // (e.g. "Recurring payments are not enabled", "auth_type required")
        // surfaces instead of "[object Object]".
        const msg = razorpayErrorMessage(err);
        console.error("[E-NACH register] Razorpay e-mandate creation failed:", msg, err);
        return NextResponse.json(
          { ok: false, error: `Razorpay e-mandate creation failed: ${msg}` },
          { status: 502 },
        );
      }
    }

    const payload = {
      itarang_lead_id: leadId,
      itarang_enach_ref: enachRef,
      customer_name: customerName,
      customer_phone: phone,
      loan_amount: sanction?.loan_amount ?? ps?.final_price ?? null,
      emi_amount: sanction?.emi ?? null,
      tenure_months: sanction?.tenure ?? null,
      nbfc_id: winner.nbfc_id,
      callback_url: callbackUrl,
    };

    const now = new Date();
    const [mandate] = await db
      .insert(enachMandates)
      .values({
        lead_id: leadId,
        nbfc_id: winner.nbfc_id,
        tenant_id: actor.tenant_id,
        enach_ref: enachRef,
        status: "in_progress",
        registration_date: now,
        triggered_by: actor.user_id,
        triggered_at: now,
        updated_at: now,
      })
      .returning({ id: enachMandates.id });

    // Redirect/deep-link → return the URL for the UI to open. The NBFC app
    // collects bank details and posts the result to callback_url.
    if (method === "redirect") {
      const sep = endpoint.includes("?") ? "&" : "?";
      const redirectUrl = `${endpoint}${sep}ref=${encodeURIComponent(enachRef)}&callback=${encodeURIComponent(callbackUrl)}`;
      return NextResponse.json({
        ok: true,
        mandate_id: mandate.id,
        enach_ref: enachRef,
        handoff: { method, redirect_url: redirectUrl },
      });
    }

    // Webhook → POST the payload to the NBFC endpoint server-to-server. A
    // delivery failure leaves the attempt in_progress so it can be retried.
    try {
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        await db
          .update(enachMandates)
          .set({
            provider_raw_status: `handoff_http_${resp.status}`,
            updated_at: new Date(),
          })
          .where(eq(enachMandates.id, mandate.id));
        return NextResponse.json(
          { ok: false, error: `Webhook handoff failed (HTTP ${resp.status}); attempt left in_progress for retry`, mandate_id: mandate.id },
          { status: 502 },
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await db
        .update(enachMandates)
        .set({ provider_raw_status: `handoff_error: ${msg}`.slice(0, 120), updated_at: new Date() })
        .where(eq(enachMandates.id, mandate.id));
      return NextResponse.json(
        { ok: false, error: `Webhook handoff error: ${msg}; attempt left in_progress for retry`, mandate_id: mandate.id },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      mandate_id: mandate.id,
      enach_ref: enachRef,
      handoff: { method, delivered: true },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: statusFromError(msg) });
  }
}
