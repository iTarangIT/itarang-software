// 23 Nov (point 4) — Settings › Dealer check alerts. Admin and Sales Head.
//
//   GET → the alert list + the iTarang team to pick from (name, email, phone).
//   PUT { recipients: [{ userId, name, email, whatsapp, emailOn, whatsappOn }] }
//
// Everyone on the list gets an email and a WhatsApp with their own link to
// approve / reject / change the dealer when a file reaches the dealer check.

import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import {
  getDealerCheckSettings,
  normalizeDealerCheckSettings,
  setDealerCheckRecipients,
  validateRecipients,
} from "@/lib/leads/dealer-check-settings";
import { isStaffRole } from "@/lib/users/staff-options";

export const dynamic = "force-dynamic";

const EDITOR_ROLES = ["admin", "sales_head"];

async function team() {
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, phone: users.phone, role: users.role })
    .from(users)
    .where(eq(users.is_active, true));
  return rows
    .filter((r) => isStaffRole(r.role))
    .map((r) => ({ id: r.id, name: r.name || r.email || "—", email: r.email, phone: r.phone, role: r.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const GET = withErrorHandler(async () => {
  await requireRole(EDITOR_ROLES);
  const [settings, people] = await Promise.all([getDealerCheckSettings(), team()]);
  return successResponse({ recipients: settings.recipients, team: people });
});

const Body = z.object({ recipients: z.array(z.record(z.string(), z.unknown())).max(20) });

export const PUT = withErrorHandler(async (req: Request) => {
  await requireRole(EDITOR_ROLES);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse("Invalid alert list", 400);
  const clean = normalizeDealerCheckSettings({ recipients: parsed.data.recipients }).recipients;
  const ids = new Set((await team()).map((t) => t.id));
  const unknown = clean.filter((r) => !ids.has(r.userId));
  if (unknown.length) return errorResponse(`${unknown[0].name} is not an active iTarang team member.`, 400);
  const problems = validateRecipients(clean);
  if (problems.length) return errorResponse(problems[0], 400);
  const saved = await setDealerCheckRecipients(clean);
  return successResponse({ recipients: saved.recipients });
});
