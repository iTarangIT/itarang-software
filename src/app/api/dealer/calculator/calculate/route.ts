import { NextResponse } from "next/server";
import { z } from "zod";
import { withErrorHandler, successResponse } from "@/lib/api-utils";
import { requireRole } from "@/lib/auth-utils";
import { db } from "@/lib/db";
import { calcLeads } from "@/lib/db/schema";
import { resolveEngineContext } from "@/lib/calculator/config-resolver";
import { calculate, ValidationError, rupeesToPaise } from "@/lib/calculator/engine";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  customerName: z.string().min(1, "Customer name is required"),
  phone: z.string().min(5, "Phone is required"),
  city: z.string().nullable().optional(),
  modelId: z.number().int().positive(),
  tenure: z.number().int().positive(),
  expectedEmi: z.number().nonnegative().optional(),
  upfrontAbility: z.number().nonnegative().optional(),
});

// Card 1 -> Card 2: resolve config, run the verified engine, persist the quote, return cards.
export const POST = withErrorHandler(async (req: Request) => {
  const user = await requireRole(["dealer"]);
  const body = bodySchema.parse(await req.json());

  const resolved = await resolveEngineContext({ modelId: body.modelId, city: body.city });

  let result;
  try {
    result = calculate(resolved.ctx, {
      model: resolved.model.displayName,
      tenure: body.tenure,
      expectedEmi: body.expectedEmi,
      upfrontAbility: body.upfrontAbility,
      city: body.city ?? undefined,
    });
  } catch (e) {
    // Map the engine's required-filter/negative validation to a structured 400 (not a 500).
    if (e instanceof ValidationError) {
      return NextResponse.json(
        { success: false, error: { message: e.message, field: e.field }, timestamp: new Date().toISOString() },
        { status: 400 },
      );
    }
    throw e;
  }

  // Persist the saved quote (inputs + result snapshot + config version).
  const [lead] = await db
    .insert(calcLeads)
    .values({
      dealerId: user.dealer_id ?? null,
      customerName: body.customerName,
      phone: body.phone,
      city: body.city ?? null,
      expectedEmiPaise: body.expectedEmi != null ? rupeesToPaise(body.expectedEmi) : null,
      upfrontAbilityPaise: body.upfrontAbility != null ? rupeesToPaise(body.upfrontAbility) : null,
      tenureMonths: body.tenure,
      modelId: body.modelId,
      filterOutcome: result.outcome,
      configVersionId: resolved.configVersionId,
      resultSnapshot: result,
    })
    .returning({ id: calcLeads.id });

  return successResponse({
    ...result,
    model: resolved.model,
    configVersionId: resolved.configVersionId,
    footer: resolved.footer,
    cardDisclaimer: resolved.cardDisclaimer,
    leadId: lead.id,
  });
});
