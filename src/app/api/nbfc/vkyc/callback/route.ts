/**
 * Public, UN-authenticated VKYC callback (§10).
 *
 *  - iTarang mode (Q1b): Decentro posts `decentroTxnId` server-to-server when
 *    the customer finishes the hosted session. We match the attempt by
 *    provider_txn_id and mark it callback-received so the /status route fetches
 *    + decodes the result on the next poll (mirrors the Step-2 Decentro flow).
 *  - Own mode (Q1a): the NBFC posts `vkyc_ref` + a CANONICAL status (§9.3); we
 *    map it onto the track directly.
 *
 * Always 200 so neither integration retries endlessly.
 */
import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { videoKycAttempts, videoKycVerifications } from "@/lib/db/schema";
import { VKYC_STATES, type VkycState } from "@/lib/nbfc/vkyc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function pickStr(body: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = body[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

async function process(body: Record<string, unknown>): Promise<{ code: number; msg: string }> {
  const decentroTxnId = pickStr(body, "decentroTxnId", "decentro_txn_id");
  const vkycRef = pickStr(body, "vkyc_ref", "reference_id", "ref");
  const rawStatus = pickStr(body, "status", "responseStatus");
  const now = new Date();

  // iTarang / Decentro path.
  if (decentroTxnId) {
    const [attempt] = await db
      .select()
      .from(videoKycAttempts)
      .where(eq(videoKycAttempts.provider_txn_id, decentroTxnId))
      .orderBy(desc(videoKycAttempts.updated_at))
      .limit(1);
    if (!attempt) {
      console.warn("[NBFC VKYC callback] No attempt for decentroTxnId:", decentroTxnId);
      return { code: 200, msg: "No matching session" };
    }
    const merged = {
      ...((attempt.provider_raw_payload ?? {}) as Record<string, unknown>),
      callback_received_at: now.toISOString(),
      callback_status: rawStatus ?? null,
    };
    await db
      .update(videoKycAttempts)
      .set({ provider_raw_status: rawStatus ?? attempt.provider_raw_status, provider_raw_payload: merged, updated_at: now })
      .where(eq(videoKycAttempts.id, attempt.id));
    return { code: 200, msg: "Accepted" };
  }

  // Own VKYC path — NBFC posts a canonical status against the track.
  if (vkycRef) {
    const [track] = await db
      .select()
      .from(videoKycVerifications)
      .where(eq(videoKycVerifications.vkyc_ref, vkycRef))
      .limit(1);
    if (!track) {
      console.warn("[NBFC VKYC callback] No track for vkyc_ref:", vkycRef);
      return { code: 200, msg: "No matching track" };
    }
    const canonical = (rawStatus ?? "").toLowerCase();
    const next: VkycState = (VKYC_STATES as readonly string[]).includes(canonical)
      ? (canonical as VkycState)
      : "in_progress";
    await db
      .update(videoKycVerifications)
      .set({
        status: next,
        provider_raw_status: rawStatus ?? track.provider_raw_status,
        provider_raw_payload: body as unknown as Record<string, unknown>,
        failure_reason: next === "failed" ? pickStr(body, "failure_reason") ?? "Reported failed by NBFC" : track.failure_reason,
        completed_at: next === "verified" || next === "failed" ? now : track.completed_at,
        updated_at: now,
      })
      .where(eq(videoKycVerifications.id, track.id));
    return { code: 200, msg: "Accepted" };
  }

  return { code: 400, msg: "Missing decentroTxnId or vkyc_ref" };
}

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const url = new URL(req.url);
    url.searchParams.forEach((v, k) => {
      if (!(k in body)) body[k] = v;
    });
    const r = await process(body);
    return new NextResponse(r.msg, { status: r.code, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (error) {
    console.error("[NBFC VKYC callback] Error:", error);
    return new NextResponse("Internal error logged", { status: 200 });
  }
}

export async function GET(req: NextRequest) {
  const body: Record<string, unknown> = {};
  new URL(req.url).searchParams.forEach((v, k) => (body[k] = v));
  if (body.decentroTxnId || body.vkyc_ref || body.reference_id) {
    const r = await process(body);
    return new NextResponse(r.msg, { status: r.code, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new NextResponse("NBFC VKYC callback endpoint", { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
