// E-307 — every action on an Ecofy lead (calls, meetings, assessment, offer,
// OTP, installation, withdrawal, close / return / reopen, financing …).
//
//   access (src/lib/ecofy/access.ts) → Ecofy API → refresh local snapshot →
//   due times for reminders → notifications.
//
// Ecofy is the system of record: if its call fails nothing local changes —
// EXCEPT (E-308) a call / remark / follow-up or a meeting booking while Ecofy
// is unavailable: the rep's work is kept in the CRM (ecofy_lead_activities)
// and replayed to Ecofy by the ticker, so the lead can still be worked.
import { requireRole } from "@/lib/auth-utils";
import { successResponse, withErrorHandler } from "@/lib/api-utils";
import { checkEcofyAction, ECOFY_ALL_ROLES } from "@/lib/ecofy/access";
import { ecofyActionSchema } from "@/lib/ecofy/actionSchemas";
import { notifyEcofyAction } from "@/lib/ecofy/notify";
import { ecofyActorName, getEcofyLeadForViewer } from "@/lib/ecofy/queries";
import { recordEcofyDueTimes } from "@/lib/ecofy/reminders";
import { isEcofyUnavailable, localKindFor, saveLocalActivity } from "@/lib/ecofy/localActivities";
import { refreshLeadFromEcofy, runEcofyAction } from "@/lib/ecofy/service";

export const dynamic = "force-dynamic";

class ActionRefused extends Error {
    constructor(message: string, public status: number) {
        super(message);
    }
}

export const POST = withErrorHandler(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireRole([...ECOFY_ALL_ROLES]);
    const { id } = await ctx.params;
    const lead = await getEcofyLeadForViewer(id, user);
    const input = ecofyActionSchema.parse(await req.json());

    const allowed = checkEcofyAction({ id: user.id, role: user.role }, lead, input.action);
    if (!allowed.ok) throw new ActionRefused(allowed.reason, allowed.status);

    const actorName = ecofyActorName(user);
    let data: unknown = null;
    let savedLocally = false;
    try {
        data = await runEcofyAction(lead, input, actorName);
    } catch (err) {
        const kind = localKindFor(input);
        if (!kind || !isEcofyUnavailable(err)) throw err;
        await saveLocalActivity({
            leadId: lead.id,
            kind,
            payload: input,
            actorId: user.id,
            actorName,
            error: err instanceof Error ? err.message : String(err),
        });
        savedLocally = true;
    }

    const moved = savedLocally
        ? { fromStage: lead.stage, toStage: lead.stage, version: lead.version }
        : await refreshLeadFromEcofy(lead);

    if (input.action === "log_activity" && input.nextFollowUpAt) {
        await recordEcofyDueTimes(lead.id, { kind: "follow_up", at: input.nextFollowUpAt });
    } else if (input.action === "book_appointment") {
        await recordEcofyDueTimes(lead.id, { kind: "appointment_booked", at: input.scheduledAt });
    } else if (input.action === "update_appointment") {
        if (input.op === "RESCHEDULE" && input.scheduledAt) {
            await recordEcofyDueTimes(lead.id, { kind: "appointment_rescheduled", at: input.scheduledAt });
        } else if (input.op !== "RESCHEDULE") {
            await recordEcofyDueTimes(lead.id, { kind: "appointment_done" });
        }
    }

    await notifyEcofyAction({
        leadId: lead.id,
        input,
        actor: { id: user.id, name: user.name, role: user.role },
        fromStage: moved.fromStage,
        toStage: moved.toStage,
    });

    return successResponse({ result: data ?? null, stage: moved.toStage, version: moved.version, savedLocally });
});
