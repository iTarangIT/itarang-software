/**
 * Per-finding AI resolution chat.
 *   GET  → the stored conversation for this finding (history).
 *   POST → one turn: the agent reads the affected source file, replies, and may
 *          propose an applyable fix. Both the user turn and the assistant turn
 *          are persisted. The Resolve step (../resolve) applies the latest fix.
 *
 * Node runtime (needs filesystem access to read the affected source). /api/* is
 * public in middleware, so this self-gates with requireSecurityAdmin().
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { securityFindings, securityFindingMessages } from "@/lib/db/schema";
import { requireSecurityAdmin } from "@/lib/security/route-guard";
import { locateSourceForTarget } from "@/lib/security/resolve/locate";
import { runResolveTurn, type ChatTurn, type FindingContext } from "@/lib/security/chat/resolve-agent";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ message: z.string().trim().min(1).max(4000) });

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSecurityAdmin();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const rows = await db
    .select()
    .from(securityFindingMessages)
    .where(eq(securityFindingMessages.finding_id, id))
    .orderBy(asc(securityFindingMessages.created_at));

  return NextResponse.json({
    ok: true,
    messages: rows.map((r) => ({
      id: r.id,
      role: r.role,
      message: r.message,
      proposedFix: r.proposed_fix ?? null,
      created_at: r.created_at?.toISOString() ?? null,
    })),
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSecurityAdmin();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "Message required" }, { status: 400 });
  }
  const userMessage = parsed.data.message;

  const [finding] = await db.select().from(securityFindings).where(eq(securityFindings.id, id)).limit(1);
  if (!finding) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  const [source, historyRows] = await Promise.all([
    locateSourceForTarget(finding.target_url),
    db
      .select()
      .from(securityFindingMessages)
      .where(eq(securityFindingMessages.finding_id, id))
      .orderBy(asc(securityFindingMessages.created_at)),
  ]);

  const history: ChatTurn[] = historyRows.map((r) => ({
    role: r.role === "assistant" ? "assistant" : r.role === "system" ? "system" : "user",
    message: r.message,
  }));

  const findingCtx: FindingContext = {
    title: finding.title,
    severity: finding.severity,
    category: finding.category,
    summary: finding.summary,
    target_url: finding.target_url,
    http_method: finding.http_method,
    reproduction: finding.reproduction,
    remediation: finding.remediation,
    evidence_json: finding.evidence_json,
    owasp_ref: finding.owasp_ref,
    cwe_ref: finding.cwe_ref,
  };

  let result;
  try {
    result = await runResolveTurn({ finding: findingCtx, source, history, userMessage });
  } catch (e) {
    console.error("[security] resolve-chat turn failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, error: "The assistant could not respond. Try again." }, { status: 502 });
  }

  // Persist both turns. The assistant row carries the proposed fix (if any) so
  // the Resolve step can pick up the latest without re-running the model.
  await db.insert(securityFindingMessages).values([
    { finding_id: id, role: "user", message: userMessage },
    { finding_id: id, role: "assistant", message: result.reply, proposed_fix: result.proposedFix ?? null },
  ]);

  return NextResponse.json({
    ok: true,
    reply: result.reply,
    proposedFix: result.proposedFix,
    sourceLocated: Boolean(source),
    sourceFile: source?.repoRelPath ?? null,
    model: result.model,
  });
}
