// LinkedIn Outreach — one account: rename, pacing settings, pause / resume.
import { eq } from "drizzle-orm";
import { z } from "zod";

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { liAccounts } from "@/lib/db/schema";
import { LINKEDIN_ROLES } from "@/lib/linkedin/roles";
import { getAccount, pauseAccount, resumeAccount, saveSettings } from "@/lib/linkedin/services/accounts";

export const dynamic = "force-dynamic";

const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/, "Use HH:MM");
const Body = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  action: z.enum(["pause", "resume"]).optional(),
  settings: z
    .object({
      invites_per_day: z.number().int().min(0).max(100),
      messages_per_day: z.number().int().min(0).max(150),
      gap_min_minutes: z.number().int().min(1).max(240),
      gap_max_minutes: z.number().int().min(1).max(480),
      send_start: hhmm,
      send_end: hhmm,
      send_days: z.string().regex(/^[1-7](,[1-7])*$/, "Comma-separated weekdays 1-7"),
      warmup_week1_invites: z.number().int().min(0).max(100),
      warmup_week2_invites: z.number().int().min(0).max(100),
      poll_interval_minutes: z.number().int().min(10).max(720),
      invite_expiry_days: z.number().int().min(1).max(90),
    })
    .partial()
    .optional(),
});

export const PATCH = withErrorHandler(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const user = await requireRole([...LINKEDIN_ROLES]);
  const account = await getAccount(id);
  if (!account) return errorResponse("Account not found", 404);
  const b = Body.parse(await req.json());
  if (b.label) await db.update(liAccounts).set({ label: b.label, updated_at: new Date() }).where(eq(liAccounts.id, account.id));
  if (b.settings) await saveSettings(account.id, b.settings, user.id);
  if (b.action === "pause") await pauseAccount(account.id, "paused", `Paused by ${user.name ?? "admin"}`);
  if (b.action === "resume") await resumeAccount(account.id, user.id);
  return successResponse(await getAccount(account.id));
});
