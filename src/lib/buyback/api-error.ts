/**
 * Turn a failed buyback API response into a sentence a dealer can act on.
 *
 * `withErrorHandler` answers every zod refusal with the literal message
 * "Validation failed" and puts the real reason in `error.details`. The intake
 * form used to print only the message — so a quantity over the line ceiling
 * showed up as a bare "Validation failed" banner with nothing to fix (BB-1058).
 * This prefers the first detail, labelled with the field the dealer sees.
 */

const FIELD_LABELS: Record<string, string> = {
  quantity: "Qty",
  variant_id: "Battery type",
  condition: "Condition",
  expected_price_per_unit: "Expected price",
  measured_voltage: "Measured voltage",
  brand: "Brand",
  chemistry: "Chemistry",
  form_factor: "Form factor",
  nominal_voltage: "Nominal voltage",
  nominal_ampere: "Nominal ampere",
  unit_weight_kg: "Unit weight",
  warranty_cycles: "Warranty cycles",
  functional_qty: "Functional qty",
  non_functional_qty: "Non-functional qty",
  iot_battery: "IOT battery",
  iot_brand_name: "IOT brand",
  prev_owner_name: "Owner name",
  prev_owner_phone: "Owner phone",
  prev_owner_pan: "Owner PAN",
  prev_owner_aadhaar_last4: "Aadhaar last 4",
  payee_account_number: "Account number",
  payee_ifsc: "IFSC",
  pincode: "Pincode",
};

interface ApiErrorBody {
  error?: {
    message?: string;
    details?: Array<{ path?: string; message?: string }> | unknown;
  };
}

export function apiErrorMessage(json: unknown, fallback: string): string {
  const err = (json as ApiErrorBody | null | undefined)?.error;
  const details = Array.isArray(err?.details) ? err.details : [];
  const first = details.find(
    (d): d is { path?: string; message: string } =>
      typeof d === "object" && d !== null && typeof (d as { message?: unknown }).message === "string",
  );

  if (first) {
    const path = typeof first.path === "string" ? first.path : "";
    const label = path ? (FIELD_LABELS[path] ?? path) : "";
    return label ? `${label}: ${first.message}` : first.message;
  }

  const message = typeof err?.message === "string" ? err.message.trim() : "";
  return message || fallback;
}
