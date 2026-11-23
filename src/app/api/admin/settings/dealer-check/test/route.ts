// 23 Nov — Settings › Dealer check alerts › "Send test". Admin and Sales Head.
//
//   POST { userId, name, email, whatsapp, emailOn, whatsappOn }
//     → { email: {ok,error}|null, whatsapp: {ok,error}|null }
//
// Sends one sample alert to one person on the list, using the row as typed
// (so it can be tested before Save). Only active iTarang team members can be
// sent to. No review / token is created — a test can never decide a file.

import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { sendDealerCheckTest } from "@/lib/leads/dealer-check-notify";
import { isStaffRole } from "@/lib/users/staff-options";

export const dynamic = "force-dynamic";

const Body = z.object({
  userId: z.string().uuid(),
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email().max(200).nullable().optional().or(z.literal("")),
  whatsapp: z.string().trim().max(20).nullable().optional(),
  emailOn: z.boolean(),
  whatsappOn: z.boolean(),
});

export const POST = withErrorHandler(async (req: Request) => {
  const me = await requireRole(["admin", "sales_head"]);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse("Check the email and mobile on this row.", 400);
  const b = parsed.data;

  const [person] = await db
    .select({ name: users.name, email: users.email, role: users.role, active: users.is_active })
    .from(users)
    .where(eq(users.id, b.userId))
    .limit(1);
  if (!person || !person.active || !isStaffRole(person.role)) {
    return errorResponse("Tests go only to active iTarang team members.", 400);
  }

  const email = b.email || null;
  const whatsapp = b.whatsapp || null;
  if (!(b.emailOn && email) && !(b.whatsappOn && whatsapp)) {
    return errorResponse("Tick Email or WhatsApp (with an address) to send a test.", 400);
  }

  const report = await sendDealerCheckTest(
    { name: b.name || person.name || "there", email, whatsapp, emailOn: b.emailOn, whatsappOn: b.whatsappOn },
    me.name || me.email || "Admin",
  );
  return successResponse(report);
});
