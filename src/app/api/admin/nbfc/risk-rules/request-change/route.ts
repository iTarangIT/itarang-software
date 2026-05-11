/**
 * E-068 — POST /api/admin/nbfc/risk-rules/request-change
 *
 * Step 1 of the dual-approval commit workflow. The first admin (requester)
 * supplies a new threshold value plus a fresh MFA token. We validate the MFA
 * token (zod min(6) — the production wiring will swap this for a real TOTP
 * verification call), capture the current value, and insert a pending change
 * request. The second admin must hit /approve to commit.
 *
 * 200 → { request_id, status, previous_value, new_value, rule_key }
 * 400 → invalid MFA, unknown rule_key, or non-numeric new_value
 * 401 → not signed in
 * 403 → not an admin
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveAdminActor, statusFromError } from "@/lib/nbfc/admin/auth";
import { createChangeRequest } from "@/lib/nbfc/admin/riskRuleApprovalService";
import { isRiskRuleKey } from "@/lib/nbfc/admin/riskRules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RequestChangeBody = z
  .object({
    rule_key: z.string().refine(isRiskRuleKey, {
      message: "rule_key must be one of the eight canonical Risk Rule Engine keys",
    }),
    new_value: z.number().finite(),
    mfa_token: z.string().min(6),
  })
  .strict();

export async function POST(req: NextRequest) {
  try {
    const actor = await resolveAdminActor(req.headers);

    let raw: unknown;
    try {
      const text = await req.text();
      raw = text ? JSON.parse(text) : {};
    } catch {
      return NextResponse.json(
        { ok: false, error: "BAD_REQUEST: invalid JSON" },
        { status: 400 },
      );
    }

    const parsed = RequestChangeBody.safeParse(raw);
    if (!parsed.success) {
      // 400 — covers invalid MFA (mfa_token shorter than 6 chars), unknown
      // rule_key, missing/non-numeric new_value. Per AC5.
      return NextResponse.json(
        { ok: false, error: "VALIDATION", issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await createChangeRequest({
      rule_key: parsed.data.rule_key,
      new_value: parsed.data.new_value,
      requester_user_id: actor.user_id,
    });

    return NextResponse.json({
      request_id: result.request_id,
      status: result.status,
      rule_key: result.rule_key,
      previous_value: result.previous_value,
      new_value: result.new_value,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: statusFromError(msg) },
    );
  }
}
