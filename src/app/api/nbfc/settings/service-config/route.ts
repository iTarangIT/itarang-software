/**
 * GET/PUT /api/nbfc/settings/service-config
 *
 * BRD Addendum V0.2 §7.4 — per-NBFC Service Opt-In + document/track config.
 *
 * GET  — current tenant's config, or an all-off default object if none exists.
 * PUT  — upsert (one row per tenant). Mutating requires the `nbfc_admin` role
 *        (§7.2: "NBFC Admin manages NBFC users and configuration").
 *
 * AuthN/Z via resolveActor() — same pattern as the dual-approval action routes.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { nbfcServiceConfig } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import { generateWebhookSecret } from "@/lib/nbfc/handoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_FI_CONFIG = {
  reinspection_cap: null as number | null,
  gps_denied_block: true,
  camera_only: true,
  required_photos: ["exterior", "customer_at_residence", "corroborator", "agent_selfie"],
};

const DEFAULTS = {
  fi_enabled: false,
  vkyc_enabled: false,
  vkyc_mode: null as "own" | "itarang" | null,
  vkyc_endpoint_url: null as string | null,
  enach_enabled: false,
  enach_handoff_method: null as "redirect" | "webhook" | "itarang_razorpay" | null,
  enach_endpoint_url: null as string | null,
  doc_agreement_method: null as "upload" | "digio" | "api_autofetch" | "own_esign" | null,
  esign_endpoint_url: null as string | null,
  esign_provider: null as string | null,
  // E-165 — iTarang-minted per-rail HMAC secrets (shown read-only to the NBFC).
  vkyc_webhook_secret: null as string | null,
  enach_webhook_secret: null as string | null,
  esign_webhook_secret: null as string | null,
  store_sanction_letter: false,
  store_loan_agreement: false,
  track_completion_gate: true,
  track_failure_halts: false,
  fi_config: DEFAULT_FI_CONFIG,
};

const Body = z.object({
  fi_enabled: z.boolean(),
  vkyc_enabled: z.boolean(),
  vkyc_mode: z.enum(["own", "itarang"]).nullable().optional(),
  vkyc_endpoint_url: z.string().url().max(2048).nullable().optional(),
  enach_enabled: z.boolean(),
  enach_handoff_method: z.enum(["redirect", "webhook", "itarang_razorpay"]).nullable().optional(),
  enach_endpoint_url: z.string().url().max(2048).nullable().optional(),
  doc_agreement_method: z.enum(["upload", "digio", "api_autofetch", "own_esign"]).nullable().optional(),
  esign_endpoint_url: z.string().url().max(2048).nullable().optional(),
  esign_provider: z.string().max(24).nullable().optional(),
  store_sanction_letter: z.boolean(),
  store_loan_agreement: z.boolean(),
  track_completion_gate: z.boolean(),
  track_failure_halts: z.boolean(),
  // E-148 §10.7 — FI agent-form + review parameters (optional; defaults apply).
  fi_config: z
    .object({
      reinspection_cap: z.number().int().min(1).max(50).nullable().optional(),
      gps_denied_block: z.boolean().optional(),
      camera_only: z.boolean().optional(),
      required_photos: z.array(z.enum(["exterior", "customer_at_residence", "corroborator", "agent_selfie", "extra"])).optional(),
    })
    .optional(),
});

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("NOT_FOUND")) return 404;
  if (msg.startsWith("CONFLICT")) return 409;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const rows = await db
      .select()
      .from(nbfcServiceConfig)
      .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
      .limit(1);
    const config = rows[0] ?? { tenant_id: actor.tenant_id, ...DEFAULTS };
    return NextResponse.json({ ok: true, config });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

export async function PUT(req: NextRequest) {
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const actor = await resolveActor(req.headers);
    if (actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: caller role '${actor.role}' is not authorised; nbfc_admin required` },
        { status: 403 },
      );
    }

    const d = parsed.data;
    // When a service is opted IN, its required config must be present.
    if (d.vkyc_enabled && !d.vkyc_mode) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: vkyc_mode is required when Video KYC is enabled" },
        { status: 400 },
      );
    }
    if (d.enach_enabled && !d.enach_handoff_method) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: enach_handoff_method is required when E-NACH is enabled" },
        { status: 400 },
      );
    }
    // The B2-B handoff modes hand off to the NBFC's own app, so they need its
    // endpoint URL. The managed Razorpay mode owns the rail and needs none.
    if (
      d.enach_enabled &&
      (d.enach_handoff_method === "redirect" || d.enach_handoff_method === "webhook") &&
      !d.enach_endpoint_url
    ) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: enach_endpoint_url is required for the redirect/webhook handoff" },
        { status: 400 },
      );
    }
    // E-165 — own-provider handoff modes need the NBFC's own endpoint URL.
    if (d.vkyc_enabled && d.vkyc_mode === "own" && !d.vkyc_endpoint_url) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: vkyc_endpoint_url is required when Video KYC mode is 'own'" },
        { status: 400 },
      );
    }
    if (d.doc_agreement_method === "own_esign" && !d.esign_endpoint_url) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: esign_endpoint_url is required when the agreement method is 'own_esign'" },
        { status: 400 },
      );
    }

    // Existing row (if any) — to preserve/observe the per-rail HMAC secrets.
    const [existing] = await db
      .select({
        vkyc_webhook_secret: nbfcServiceConfig.vkyc_webhook_secret,
        enach_webhook_secret: nbfcServiceConfig.enach_webhook_secret,
        esign_webhook_secret: nbfcServiceConfig.esign_webhook_secret,
      })
      .from(nbfcServiceConfig)
      .where(eq(nbfcServiceConfig.tenant_id, actor.tenant_id))
      .limit(1);
    // Mint a secret the first time a rail enters its own-provider handoff mode;
    // otherwise preserve whatever exists (so toggling away then back is stable).
    const ensureSecret = (isHandoff: boolean, current: string | null | undefined): string | null =>
      current ?? (isHandoff ? generateWebhookSecret() : null);
    const vkycSecret = ensureSecret(d.vkyc_enabled && d.vkyc_mode === "own", existing?.vkyc_webhook_secret);
    const enachSecret = ensureSecret(
      d.enach_enabled && (d.enach_handoff_method === "redirect" || d.enach_handoff_method === "webhook"),
      existing?.enach_webhook_secret,
    );
    const esignSecret = ensureSecret(d.doc_agreement_method === "own_esign", existing?.esign_webhook_secret);

    const now = new Date();
    const fiConfig = { ...DEFAULT_FI_CONFIG, ...(d.fi_config ?? {}) };
    const values = {
      tenant_id: actor.tenant_id,
      fi_enabled: d.fi_enabled,
      vkyc_enabled: d.vkyc_enabled,
      vkyc_mode: d.vkyc_mode ?? null,
      vkyc_endpoint_url: d.vkyc_endpoint_url ?? null,
      enach_enabled: d.enach_enabled,
      enach_handoff_method: d.enach_handoff_method ?? null,
      enach_endpoint_url: d.enach_endpoint_url ?? null,
      doc_agreement_method: d.doc_agreement_method ?? null,
      esign_endpoint_url: d.esign_endpoint_url ?? null,
      esign_provider: d.esign_provider ?? null,
      vkyc_webhook_secret: vkycSecret,
      enach_webhook_secret: enachSecret,
      esign_webhook_secret: esignSecret,
      store_sanction_letter: d.store_sanction_letter,
      store_loan_agreement: d.store_loan_agreement,
      track_completion_gate: d.track_completion_gate,
      track_failure_halts: d.track_failure_halts,
      fi_config: fiConfig,
      updated_at: now,
    };

    await db
      .insert(nbfcServiceConfig)
      .values(values)
      .onConflictDoUpdate({
        target: nbfcServiceConfig.tenant_id,
        set: {
          fi_enabled: values.fi_enabled,
          fi_config: values.fi_config,
          vkyc_enabled: values.vkyc_enabled,
          vkyc_mode: values.vkyc_mode,
          vkyc_endpoint_url: values.vkyc_endpoint_url,
          enach_enabled: values.enach_enabled,
          enach_handoff_method: values.enach_handoff_method,
          enach_endpoint_url: values.enach_endpoint_url,
          doc_agreement_method: values.doc_agreement_method,
          esign_endpoint_url: values.esign_endpoint_url,
          esign_provider: values.esign_provider,
          vkyc_webhook_secret: values.vkyc_webhook_secret,
          enach_webhook_secret: values.enach_webhook_secret,
          esign_webhook_secret: values.esign_webhook_secret,
          store_sanction_letter: values.store_sanction_letter,
          store_loan_agreement: values.store_loan_agreement,
          track_completion_gate: values.track_completion_gate,
          track_failure_halts: values.track_failure_halts,
          updated_at: now,
        },
      });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
