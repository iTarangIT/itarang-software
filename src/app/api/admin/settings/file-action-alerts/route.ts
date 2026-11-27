// 27 Nov 2026 — Settings › File action alerts. Admin and Sales Head.
//
//   GET → the lead-file notification types (grouped) + the saved ticks.
//   PUT { rules: { [type]: { [party]: { bell, email, whatsapp } } } }
//
// A type missing from `rules` keeps the built-in behaviour. See
// src/lib/notifications/party-routing-rules.ts for what a saved rule does.

import { z } from "zod";

import { errorResponse, successResponse, withErrorHandler } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { isEmailLocked } from "@/lib/notifications/catalog";
import { getPartyRouting, setPartyRouting } from "@/lib/notifications/party-routing";
import { FILE_CATEGORIES, normalizePartyRouting } from "@/lib/notifications/party-routing-rules";
import { typeGroups } from "@/lib/notifications/registry";

export const dynamic = "force-dynamic";

const EDITOR_ROLES = ["admin", "sales_head"];

function fileTypeGroups() {
  return typeGroups()
    .filter((g) => FILE_CATEGORIES.includes(g.category))
    .map((g) => ({
      category: g.category,
      types: g.types.map((t) => ({ ...t, emailLocked: isEmailLocked(t.value) })),
    }));
}

export const GET = withErrorHandler(async () => {
  await requireRole(EDITOR_ROLES);
  const settings = await getPartyRouting();
  return successResponse({ groups: fileTypeGroups(), rules: settings.rules });
});

const Body = z.object({ rules: z.record(z.string(), z.unknown()) });

export const PUT = withErrorHandler(async (req: Request) => {
  await requireRole(EDITOR_ROLES);
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return errorResponse("Invalid settings", 400);
  const known = new Set(fileTypeGroups().flatMap((g) => g.types.map((t) => t.value)));
  const clean = normalizePartyRouting(parsed.data, (t) => known.has(t));
  const saved = await setPartyRouting(clean);
  return successResponse({ rules: saved.rules });
});
