/**
 * GET/PUT/DELETE /api/nbfc/settings/esign-credentials — per-NBFC e-sign provider
 * credentials vault (E-166, Model B). GET is open to any tenant member (returns
 * configured-state only, NEVER the secret). PUT/DELETE require nbfc_admin (same
 * gate as the Document-Handling service-config).
 *
 * Secrets are AES-256-GCM encrypted at rest (src/lib/nbfc/esign/crypto.ts). On
 * PUT a secret field left as the __UNCHANGED__ sentinel keeps its stored value.
 */
import { NextRequest, NextResponse } from "next/server";
import { clientError } from "@/lib/nbfc/http-error";
import { z } from "zod";
import { and, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { nbfcProviderCredentials } from "@/lib/db/schema";
import { resolveActor } from "@/lib/nbfc/dual-approval/auth";
import {
  getEsignAdapterMeta,
  getEsignProvider,
  isKnownEsignProvider,
  listEsignProviders,
} from "@/lib/nbfc/esign/registry";
import { credentialAad, decryptJson, encryptJson, isVaultEnabled } from "@/lib/nbfc/esign/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SECRET_SENTINEL = "__UNCHANGED__";

function statusFromError(msg: string): number {
  if (msg.startsWith("UNAUTHORIZED")) return 401;
  if (msg.startsWith("FORBIDDEN")) return 403;
  if (msg.startsWith("BAD_REQUEST")) return 400;
  return 500;
}

const Body = z.object({
  provider_type: z.string().min(1).max(24),
  environment: z.enum(["sandbox", "production"]),
  secrets: z.record(z.string()).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    const rows = await db
      .select()
      .from(nbfcProviderCredentials)
      .where(eq(nbfcProviderCredentials.tenant_id, actor.tenant_id));
    const byType = new Map(rows.map((r) => [r.provider_type, r]));
    const providers = listEsignProviders().map((meta) => {
      const row = byType.get(meta.id);
      return {
        id: meta.id,
        label: meta.label,
        description: meta.description ?? null,
        environments: meta.environments,
        credentialSchema: meta.credentialSchema,
        configured: !!row,
        environment: row?.environment ?? meta.environments[0],
        label_hint: row?.label ?? null,
        last_test_ok: row?.last_test_ok ?? null,
        last_tested_at: row?.last_tested_at ?? null,
      };
    });
    return NextResponse.json({
      ok: true,
      canEdit: actor.role === "nbfc_admin",
      vaultEnabled: isVaultEnabled(),
      providers,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (actor.role !== "nbfc_admin") {
      return NextResponse.json(
        { ok: false, error: `FORBIDDEN: role '${actor.role}' is not authorised; nbfc_admin required` },
        { status: 403 },
      );
    }
    if (!isVaultEnabled()) {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: credential vault disabled (NBFC_CREDENTIALS_ENC_KEY not set)" },
        { status: 400 },
      );
    }
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: invalid JSON" }, { status: 400 });
    }
    const parsed = Body.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "VALIDATION", issues: parsed.error.issues }, { status: 400 });
    }
    const d = parsed.data;
    const meta = getEsignAdapterMeta(d.provider_type);
    if (!meta) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: unknown e-sign provider" }, { status: 400 });
    }

    const aad = credentialAad(actor.tenant_id, d.provider_type);
    const [existing] = await db
      .select()
      .from(nbfcProviderCredentials)
      .where(
        and(
          eq(nbfcProviderCredentials.tenant_id, actor.tenant_id),
          eq(nbfcProviderCredentials.provider_type, d.provider_type),
        ),
      )
      .limit(1);
    const currentSecrets: Record<string, string> = existing
      ? ((decryptJson(
          { ciphertext: existing.ciphertext, iv: existing.iv, authTag: existing.auth_tag, keyVersion: existing.key_version },
          aad,
        ) as Record<string, string>) ?? {})
      : {};

    // Merge per the adapter's declared credential schema. Secret fields left as
    // the sentinel (or blank) keep the stored value; required-but-missing fails.
    const incoming = d.secrets ?? {};
    const merged: Record<string, string> = {};
    for (const field of meta.credentialSchema) {
      const provided = incoming[field.key];
      const isUnchanged = provided === undefined || provided === SECRET_SENTINEL || provided === "";
      if (!isUnchanged) {
        merged[field.key] = String(provided);
      } else if (currentSecrets[field.key] != null && currentSecrets[field.key] !== "") {
        merged[field.key] = currentSecrets[field.key];
      } else {
        return NextResponse.json(
          { ok: false, error: `BAD_REQUEST: ${field.label} is required` },
          { status: 400 },
        );
      }
    }

    // Test the connection — warn-only (the save proceeds regardless).
    let lastTestOk: boolean | null = null;
    try {
      const provider = await getEsignProvider(d.provider_type);
      const result = await provider.testConnection({
        providerId: d.provider_type,
        source: "tenant",
        environment: d.environment,
        secrets: merged,
      });
      lastTestOk = result.ok;
    } catch {
      lastTestOk = false;
    }

    // A non-secret field value makes a friendly hint; else a masked tag.
    const hintField = meta.credentialSchema.find((f) => !f.secret);
    const label = hintField ? merged[hintField.key] : "configured";

    const blob = encryptJson(merged, aad);
    const now = new Date();
    const values = {
      tenant_id: actor.tenant_id,
      provider_type: d.provider_type,
      environment: d.environment,
      ciphertext: blob.ciphertext,
      iv: blob.iv,
      auth_tag: blob.authTag,
      key_version: blob.keyVersion,
      label,
      last_tested_at: now,
      last_test_ok: lastTestOk,
      updated_at: now,
    };
    await db
      .insert(nbfcProviderCredentials)
      .values(values)
      .onConflictDoUpdate({
        target: [nbfcProviderCredentials.tenant_id, nbfcProviderCredentials.provider_type],
        set: {
          environment: values.environment,
          ciphertext: values.ciphertext,
          iv: values.iv,
          auth_tag: values.auth_tag,
          key_version: values.key_version,
          label: values.label,
          last_tested_at: values.last_tested_at,
          last_test_ok: values.last_test_ok,
          updated_at: values.updated_at,
        },
      });

    return NextResponse.json({ ok: true, last_test_ok: lastTestOk });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const actor = await resolveActor(req.headers);
    if (actor.role !== "nbfc_admin") {
      return NextResponse.json({ ok: false, error: "FORBIDDEN: nbfc_admin required" }, { status: 403 });
    }
    const provider = new URL(req.url).searchParams.get("provider") ?? "";
    if (!isKnownEsignProvider(provider)) {
      return NextResponse.json({ ok: false, error: "BAD_REQUEST: unknown provider" }, { status: 400 });
    }
    await db
      .delete(nbfcProviderCredentials)
      .where(
        and(
          eq(nbfcProviderCredentials.tenant_id, actor.tenant_id),
          eq(nbfcProviderCredentials.provider_type, provider),
        ),
      );
    return NextResponse.json({ ok: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: clientError(msg) }, { status: statusFromError(msg) });
  }
}
