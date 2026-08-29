import { z } from "zod";

import { storedFileUrl } from "@/lib/api-utils";

/**
 * Shared Zod shape for the dealer's product selection.
 *
 * Extracted from `/api/lead/[id]/submit-product-selection` so the Step-5 save
 * route can reuse it verbatim instead of carrying a divergent copy — the two
 * write the same column set on `product_selections` and drifting schemas is
 * how one of them silently stops persisting a field.
 *
 * The battery serial and the price are **optional in the base shape**. Since
 * the Step-4/Step-5 split, a finance lead is routed to its lenders before any
 * physical stock is picked: the NBFC underwrites the customer's profile, not a
 * specific battery. The serial and the settled price arrive later, at Step 5,
 * where `step5ProductSelectionSchema` makes them mandatory again.
 *
 * Cash is unaffected — `confirm-cash-sale` keeps its own schema and still
 * demands a serial up front, because a cash lead completes at Step 4 and never
 * reaches Step 5.
 */

export const paraLineSchema = z.object({
  asset_type: z.string(),
  model_type: z.string().nullable().optional(),
  product_name: z.string().nullable().optional(),
  product_id: z.string().nullable().optional(),
  qty: z.number().min(0),
  unit_gross: z.number().min(0),
  gst_percent: z.number().min(0),
  gst_amount: z.number().min(0),
  unit_net: z.number().min(0),
  line_gross: z.number().min(0),
  line_gst: z.number().min(0),
  line_net: z.number().min(0),
});

/** The columns both writers share. Serial + pricing are optional here. */
export const productSelectionFields = {
  batterySerial: z.string().min(1).nullable().optional(),
  // Charger is optional — battery-only sales (with or without paraphernalia)
  // are a valid order. When null/undefined, charger inventory is left alone.
  chargerSerial: z.string().min(1).nullable().optional(),
  paraphernalia: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  paraphernaliaLines: z.array(paraLineSchema).optional(),
  dealerMargin: z.number().min(0).optional(),
  // E-273: GST on the margin (rate + rupees), captured with the rest of the snapshot.
  dealerMarginGstPercent: z.number().min(0).optional(),
  dealerMarginGstAmount: z.number().min(0).optional(),
  finalPrice: z.number().min(0).optional(),
  batteryPrice: z.number().min(0).optional(),
  chargerPrice: z.number().min(0).optional(),
  paraphernaliaCost: z.number().min(0).optional(),
  // GST snapshot — captured exactly as the dealer saw it on submit.
  batteryGross: z.number().min(0).optional(),
  batteryGstPercent: z.number().min(0).optional(),
  batteryGstAmount: z.number().min(0).optional(),
  batteryNet: z.number().min(0).optional(),
  chargerGross: z.number().min(0).optional(),
  chargerGstPercent: z.number().min(0).optional(),
  chargerGstAmount: z.number().min(0).optional(),
  chargerNet: z.number().min(0).optional(),
  grossSubtotal: z.number().min(0).optional(),
  gstSubtotal: z.number().min(0).optional(),
  netSubtotal: z.number().min(0).optional(),
  category: z.string().optional(),
  // E-103: was subCategory; renamed to modelNumber to mirror the
  // product_selections.model_number column (Sync Audit G-05).
  modelNumber: z.string().optional(),
  // E-130 / Addendum V0.1 §5.1, §5.3 — dealer-captured product photos.
  batteryPhotoUrls: z.array(storedFileUrl).optional(),
  chargerPhotoUrls: z.array(storedFileUrl).optional(),
};

/**
 * Step 4 finance submit. Everything about the physical product is optional —
 * the button now means "send this customer to the lenders", and the dealer may
 * legitimately have picked nothing yet.
 */
export const submitProductSelectionSchema = z.object({
  ...productSelectionFields,
  // E-208 — Step-4 pre-sanction document bucket (≤10 items, all formats).
  preSanctionDocs: z
    .array(
      z.object({
        url: storedFileUrl,
        name: z.string(),
        type: z.string(),
        size: z.number(),
      }),
    )
    .max(10)
    .optional(),
  selectedNbfcs: z
    .array(
      z.object({
        nbfc_id: z.string(),
        loan_product_id: z.union([z.string(), z.number()]).optional(),
      }),
    )
    // E-275 — one lending partner per submission (was 2).
    .max(1)
    .optional(),
  // E-275 — the off-platform "Bajaj Finance" card. Mutually exclusive with
  // selectedNbfcs; the lead goes straight to Step 5 with an external sanction.
  externalLender: z.literal("bajaj_finance").optional(),
  customerDisclosureAck: z.boolean().optional(),
}).refine(
  (b) => !(b.externalLender && b.selectedNbfcs && b.selectedNbfcs.length > 0),
  { message: "Pick either an NBFC or the external lender, not both." },
);

/**
 * Step 5 save. This is where the dealer commits to actual stock, so the serial
 * and the price the customer is about to approve over OTP are required.
 */
export const step5ProductSelectionSchema = z.object({
  ...productSelectionFields,
  batterySerial: z.string().min(1),
  dealerMargin: z.number().min(0),
  finalPrice: z.number().min(0),
});

export type SubmitProductSelectionBody = z.infer<typeof submitProductSelectionSchema>;
export type Step5ProductSelectionBody = z.infer<typeof step5ProductSelectionSchema>;

/**
 * Maps a validated body onto the `product_selections` column names. Shared so
 * the Step-4 insert and the Step-5 update can never disagree about which
 * field lands in which column, or about decimal stringification.
 */
export function productSelectionColumns(
  body: Pick<
    SubmitProductSelectionBody,
    keyof typeof productSelectionFields
  >,
): Record<string, unknown> {
  return {
    battery_serial: body.batterySerial ?? null,
    charger_serial: body.chargerSerial ?? null,
    paraphernalia: body.paraphernalia ?? {},
    paraphernalia_lines: body.paraphernaliaLines ?? [],
    battery_price: body.batteryPrice?.toString(),
    charger_price: body.chargerPrice?.toString(),
    paraphernalia_cost: body.paraphernaliaCost?.toString(),
    dealer_margin: body.dealerMargin?.toString(),
    dealer_margin_gst_percent: body.dealerMarginGstPercent?.toString(),
    dealer_margin_gst_amount: body.dealerMarginGstAmount?.toString(),
    final_price: body.finalPrice?.toString(),
    battery_gross: body.batteryGross?.toString(),
    battery_gst_percent: body.batteryGstPercent?.toString(),
    battery_gst_amount: body.batteryGstAmount?.toString(),
    battery_net: body.batteryNet?.toString(),
    charger_gross: body.chargerGross?.toString(),
    charger_gst_percent: body.chargerGstPercent?.toString(),
    charger_gst_amount: body.chargerGstAmount?.toString(),
    charger_net: body.chargerNet?.toString(),
    gross_subtotal: body.grossSubtotal?.toString(),
    gst_subtotal: body.gstSubtotal?.toString(),
    net_subtotal: body.netSubtotal?.toString(),
    battery_photo_urls: body.batteryPhotoUrls ?? [],
    charger_photo_urls: body.chargerPhotoUrls ?? [],
  };
}
