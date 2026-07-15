/**
 * The dealer-declared battery spec on a buyback line (E-191).
 *
 * One module owns the field list, the zod validation and the body→column
 * mapping, because THREE places would otherwise each hold their own copy and
 * drift: the line-create route, the line-edit route, and the intake form's
 * payload builder. The submit gate's required-field rule lives with the other
 * gate rules in submit-gate.ts; this file only defines what the fields ARE.
 *
 * Every field is optional/nullable at the API boundary — the intake autosaves
 * a line the instant a SKU is picked, before the dealer has typed anything.
 * "Required" is enforced at SUBMIT time by the gate, exactly like the 5-photo
 * minimum, so the button and the server can never disagree.
 */

import { z } from "zod";

export const CHEMISTRIES = ["NMC", "LFP"] as const;
export const FORM_FACTORS = ["CELL", "PRISMATIC", "CYLINDRICAL"] as const;

export type Chemistry = (typeof CHEMISTRIES)[number];
export type FormFactor = (typeof FORM_FACTORS)[number];

/** Matches MAX_QTY_PER_LINE in the line routes — the split cannot exceed it. */
const MAX_SPLIT_QTY = 500;

export const lineSpecSchema = z.object({
  brand: z.string().trim().min(1).max(120).nullish(),
  chemistry: z.enum(CHEMISTRIES).nullish(),
  form_factor: z.enum(FORM_FACTORS).nullish(),
  nominal_voltage: z.number().positive().max(1000).nullish(),
  nominal_ampere: z.number().positive().max(10000).nullish(),
  unit_weight_kg: z.number().positive().max(10000).nullish(),
  warranty_cycles: z.number().int().nonnegative().max(100000).nullish(),
  functional_qty: z.number().int().nonnegative().max(MAX_SPLIT_QTY).nullish(),
  non_functional_qty: z.number().int().nonnegative().max(MAX_SPLIT_QTY).nullish(),
  iot_battery: z.boolean().nullish(),
  iot_brand_name: z.string().trim().max(120).nullish(),
});

export type LineSpecBody = z.infer<typeof lineSpecSchema>;

/**
 * The spec columns as drizzle's insert/update model wants them — numerics as
 * strings (the schema declares them `numeric`, same convention as
 * expected_price_per_unit / measured_voltage). A key that is absent means
 * "leave the column alone"; null means "clear it".
 */
export interface LineSpecColumns {
  brand?: string | null;
  chemistry?: string | null;
  form_factor?: string | null;
  nominal_voltage?: string | null;
  nominal_ampere?: string | null;
  unit_weight_kg?: string | null;
  warranty_cycles?: number | null;
  functional_qty?: number | null;
  non_functional_qty?: number | null;
  iot_battery?: boolean | null;
  iot_brand_name?: string | null;
}

/**
 * The drizzle `.set()` / `.values()` fragment for a validated body.
 *
 * PATCH semantics per field: absent = leave alone, null = clear, value = set.
 */
export function specColumnsFromBody(body: LineSpecBody): LineSpecColumns {
  const out: LineSpecColumns = {};

  if (body.brand !== undefined) out.brand = body.brand ?? null;
  if (body.chemistry !== undefined) out.chemistry = body.chemistry ?? null;
  if (body.form_factor !== undefined) out.form_factor = body.form_factor ?? null;
  if (body.nominal_voltage !== undefined)
    out.nominal_voltage = body.nominal_voltage === null ? null : body.nominal_voltage.toString();
  if (body.nominal_ampere !== undefined)
    out.nominal_ampere = body.nominal_ampere === null ? null : body.nominal_ampere.toString();
  if (body.unit_weight_kg !== undefined)
    out.unit_weight_kg = body.unit_weight_kg === null ? null : body.unit_weight_kg.toString();
  if (body.warranty_cycles !== undefined) out.warranty_cycles = body.warranty_cycles ?? null;
  if (body.functional_qty !== undefined) out.functional_qty = body.functional_qty ?? null;
  if (body.non_functional_qty !== undefined)
    out.non_functional_qty = body.non_functional_qty ?? null;
  if (body.iot_battery !== undefined) out.iot_battery = body.iot_battery ?? null;
  if (body.iot_brand_name !== undefined) out.iot_brand_name = body.iot_brand_name ?? null;

  return out;
}

/** The spec as read back off a line row. Everything nullable — old rows have nothing. */
export interface LineSpec {
  brand: string | null;
  chemistry: string | null;
  form_factor: string | null;
  nominal_voltage: number | string | null;
  nominal_ampere: number | string | null;
  unit_weight_kg: number | string | null;
  warranty_cycles: number | null;
  functional_qty: number | null;
  non_functional_qty: number | null;
  iot_battery: boolean | null;
  iot_brand_name: string | null;
}
