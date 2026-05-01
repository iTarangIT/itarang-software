/**
 * E-030 — Nightly cron: recompute PCI (Payment Consistency Index) for every
 * active loan and persist it on borrower_risk_scores. Insert a pci_low row in
 * nbfc_risk_alerts for any borrower whose PCI dips below 0.40.
 *
 * Schedule: nightly via vercel.json cron entry. Authorisation:
 *   1. Vercel cron header (`x-vercel-cron`) — automatic.
 *   2. Bearer CRON_SECRET — manual / Playwright.
 *   3. Triple-guarded NBFC test bypass (admin role) — Playwright in CI.
 *   4. In non-production, unauthenticated requests are accepted (mirrors
 *      `/api/cron/nbfc-cor-expiry`) so dev tooling and the loop can fire it.
 *
 * Returns: { ok, computed_count, alert_triggered_count, run_at }.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { computePciForAllLoans } from "@/lib/nbfc/pci/computePci";
import {
  isTestBypassRequest,
  resolveAdminActor,
  ADMIN_ROLES,
} from "@/lib/nbfc/admin/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const RequestSchema = z.object({}).passthrough();

function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

async function isAuthorised(req: NextRequest): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  // Vercel cron — automatic header.
  if (req.headers.get("x-vercel-cron")) return { ok: true };

  // Manual: Bearer CRON_SECRET.
  const auth = req.headers.get("authorization") ?? "";
  const expected = process.env.CRON_SECRET;
  if (expected && auth === `Bearer ${expected}`) return { ok: true };

  // NBFC test bypass — admin role required (mirrors other admin-gated routes).
  if (isTestBypassRequest(req.headers)) {
    try {
      const actor = await resolveAdminActor(req.headers);
      if (
        !ADMIN_ROLES.includes(actor.role as (typeof ADMIN_ROLES)[number])
      ) {
        return { ok: false, status: 403, error: "FORBIDDEN: not an admin" };
      }
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = msg.startsWith("UNAUTHORIZED")
        ? 401
        : msg.startsWith("FORBIDDEN")
          ? 403
          : 500;
      return { ok: false, status, error: msg };
    }
  }

  // Non-production: allow unauthenticated triggers so dev / loop tooling works.
  if (!isProd()) return { ok: true };

  return { ok: false, status: 401, error: "UNAUTHORIZED" };
}

async function handle(req: NextRequest) {
  const auth = await isAuthorised(req);
  if (!auth.ok) {
    return NextResponse.json(
      { ok: false, error: auth.error ?? "UNAUTHORIZED" },
      { status: auth.status ?? 401 },
    );
  }

  // Parse the (empty) request body when one is sent. POST with no body is
  // also fine — the schema allows the empty object.
  if (req.method === "POST") {
    try {
      const raw = await req.text();
      if (raw.length > 0) {
        const json = JSON.parse(raw);
        const parsed = RequestSchema.safeParse(json);
        if (!parsed.success) {
          return NextResponse.json(
            {
              ok: false,
              error: "VALIDATION",
              issues: parsed.error.issues,
            },
            { status: 422 },
          );
        }
      }
    } catch {
      return NextResponse.json(
        { ok: false, error: "VALIDATION: invalid JSON" },
        { status: 422 },
      );
    }
  }

  try {
    const result = await computePciForAllLoans();
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error("[cron/nbfc/compute-pci] failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
