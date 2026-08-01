/**
 * Auto-apply the agreed fix for a finding, then mark it resolved.
 *
 * SAFETY RAILS (this writes live source):
 *   - gated behind SECURITY_AUTOFIX_ENABLED=1 (off by default);
 *   - the file is re-located from the finding's target_url server-side (the
 *     model's suggested path is NOT trusted) and must sit inside repo src/;
 *   - the edit is a deterministic single-occurrence string replacement — the
 *     `search` must appear EXACTLY once, else we refuse (409);
 *   - a `.bak` backup is written, the change verified, and rolled back on any
 *     failure so a bad edit can't leave the app broken;
 *   - on a standalone prod build there are no source files, so locate returns
 *     null and we refuse — the chat still yields a diff to apply by hand.
 *
 * Node runtime (filesystem). Self-gates with requireSecurityAdmin().
 */
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { securityFindings, securityFindingMessages } from "@/lib/db/schema";
import { requireSecurityAdmin } from "@/lib/security/route-guard";
import { locateSourceForTarget, isInsideRepoSrc } from "@/lib/security/resolve/locate";
import { recordFindingAction, requestOrigin } from "@/lib/security/resolution-audit";
import type { ProposedFix } from "@/lib/security/chat/resolve-agent";

export const dynamic = "force-dynamic";

function makeDiff(file: string, search: string, replace: string): string {
  const minus = search.split("\n").map((l) => `- ${l}`).join("\n");
  const plus = replace.split("\n").map((l) => `+ ${l}`).join("\n");
  return `--- a/${file}\n+++ b/${file}\n${minus}\n${plus}`;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireSecurityAdmin();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  // Where the resolve was triggered from — recorded on the finding and in the
  // append-only audit trail (E-219) so the History tab can show the origin IP.
  const origin = requestOrigin(req);

  const [finding] = await db.select().from(securityFindings).where(eq(securityFindings.id, id)).limit(1);
  if (!finding) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  // Latest assistant turn that carried a proposed fix.
  const [msg] = await db
    .select()
    .from(securityFindingMessages)
    .where(and(eq(securityFindingMessages.finding_id, id), isNotNull(securityFindingMessages.proposed_fix)))
    .orderBy(desc(securityFindingMessages.created_at))
    .limit(1);

  const fix = msg?.proposed_fix as ProposedFix | undefined;
  if (!fix || !fix.search || !fix.replace) {
    return NextResponse.json(
      { ok: false, error: "No fix has been proposed yet. Discuss a fix in the chat first." },
      { status: 400 },
    );
  }
  const diff = makeDiff(fix.file || finding.target_url, fix.search, fix.replace);

  // Feature gate — with auto-apply off, hand back the diff to apply manually.
  if (process.env.SECURITY_AUTOFIX_ENABLED !== "1") {
    return NextResponse.json(
      {
        ok: false,
        applied: false,
        error: "Auto-apply is disabled (SECURITY_AUTOFIX_ENABLED is not set). Apply the diff below manually, then Mark Resolved.",
        diff,
      },
      { status: 409 },
    );
  }

  // Re-locate the real file server-side; never trust the model's path.
  const source = await locateSourceForTarget(finding.target_url);
  if (!source) {
    return NextResponse.json(
      {
        ok: false,
        applied: false,
        error: "The affected source file isn't on disk here (e.g. a production build). Apply the diff below in your repo, then Mark Resolved.",
        diff,
      },
      { status: 409 },
    );
  }
  if (!isInsideRepoSrc(source.absPath) || !/\.(ts|tsx)$/.test(source.absPath)) {
    return NextResponse.json({ ok: false, error: "Refusing to edit a file outside src/." }, { status: 409 });
  }

  const original = await fs.readFile(source.absPath, "utf8");
  const occurrences = original.split(fix.search).length - 1;
  if (occurrences === 0) {
    return NextResponse.json(
      { ok: false, applied: false, error: "The code to change no longer matches the file (it may have been edited). Re-open the chat to draft a fresh fix.", diff },
      { status: 409 },
    );
  }
  if (occurrences > 1) {
    return NextResponse.json(
      { ok: false, applied: false, error: "The proposed change matches more than one place in the file, so it's ambiguous. Re-open the chat and ask for a more specific edit.", diff },
      { status: 409 },
    );
  }

  const backupPath = `${source.absPath}.bak`;
  const updated = original.replace(fix.search, fix.replace);
  try {
    await fs.writeFile(backupPath, original, "utf8");
    await fs.writeFile(source.absPath, updated, "utf8");

    // Verify the write took and matches what we intended.
    const after = await fs.readFile(source.absPath, "utf8");
    if (after !== updated || !after.includes(fix.replace)) {
      throw new Error("post-write verification mismatch");
    }
  } catch (e) {
    // Roll back to the backup / original so a failed apply can't break the app.
    try {
      await fs.writeFile(source.absPath, original, "utf8");
    } catch {
      /* original is still in `original` var; nothing more we can do here */
    }
    console.error("[security] auto-apply failed, rolled back:", e instanceof Error ? e.message : e);
    return NextResponse.json(
      { ok: false, applied: false, error: "Applying the fix failed; the file was restored unchanged. Try again or apply the diff manually.", diff },
      { status: 500 },
    );
  }

  const now = new Date();
  const report = {
    file: source.repoRelPath,
    diff,
    applied: true,
    verified: true,
    backup_path: `${source.repoRelPath}.bak`,
    applied_at: now.toISOString(),
    applied_by: auth.user.email ?? auth.user.id,
    resolved_from_ip: origin.ip,
    user_agent: origin.userAgent,
    method: "auto_apply" as const,
    explanation: fix.explanation ?? "",
  };

  const summary = fix.explanation || `Applied an automated fix to ${source.repoRelPath}.`;

  await db
    .update(securityFindings)
    .set({
      status: "resolved",
      resolved_at: now,
      resolved_by: auth.user.id,
      resolved_by_email: auth.user.email,
      resolved_ip: origin.ip,
      resolved_user_agent: origin.userAgent,
      resolution_method: "auto_apply",
      resolution_summary: summary,
      resolution_report: report,
    })
    .where(eq(securityFindings.id, id));

  // Append-only audit row (E-219) — powers the per-finding History timeline.
  await recordFindingAction({
    findingId: id,
    action: "auto_apply",
    method: "auto_apply",
    actor: auth.user,
    origin,
    summary: `Fix auto-applied to ${source.repoRelPath} and finding marked resolved.`,
    detail: report,
  });

  // Leave an audit line in the conversation.
  await db.insert(securityFindingMessages).values({
    finding_id: id,
    role: "system",
    message: `Fix applied to ${source.repoRelPath} by ${report.applied_by} from IP ${origin.ip ?? "unknown"} and finding marked resolved. Backup at ${report.backup_path}.`,
  });

  return NextResponse.json({ ok: true, applied: true, report, diff });
}
