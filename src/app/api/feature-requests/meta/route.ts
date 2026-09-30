/**
 * GET /api/feature-requests/meta — the caller's seat and the active members.
 */
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { loadMembers, requireSeat } from "@/lib/feature-requests/server";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
  const user = await requireSeat();
  const members = await loadMembers();
  return successResponse({
    me: { id: user.id, name: user.name, seat: user.seat },
    members: members.map((m) => ({ id: m.id, name: m.name, seat: m.seat })),
  });
});
