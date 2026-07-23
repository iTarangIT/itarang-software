// Dealer business type (E-202) — 'new' | 'scrap' | 'both'. Captured at
// onboarding Step 1, stored on dealer_onboarding_applications.dealer_type, and
// copied to dealers.dealer_type on approval.
//
// Distinct from company_type, which is the LEGAL structure (sole proprietorship /
// partnership / private limited). The admin review page shows both.
//
// Single source of truth for the values and their labels — the onboarding
// selector, the onboarding review step, and the admin verification queue +
// detail page all read from here so the wording can never drift apart.

export const DEALER_TYPES = ["new", "scrap", "both"] as const;

export type DealerTypeValue = (typeof DEALER_TYPES)[number];

export type DealerTypeOption = {
  value: DealerTypeValue;
  /** Full label, used wherever the type is displayed on its own. */
  label: string;
  /** Shorter title for the onboarding selector cards, which pair it with `description`. */
  shortLabel: string;
  description: string;
};

export const DEALER_TYPE_OPTIONS: DealerTypeOption[] = [
  {
    value: "new",
    label: "New Battery Dealer",
    shortLabel: "New Battery Dealer",
    description: "Sells new batteries",
  },
  {
    value: "scrap",
    label: "Scrap / Old Battery Dealer",
    shortLabel: "Scrap / Old Battery Dealer",
    description: "Deals in old / scrap batteries",
  },
  {
    value: "both",
    label: "Both (New & Old Batteries)",
    shortLabel: "Both",
    description: "New & old batteries",
  },
];

export const DEALER_TYPE_LABELS: Record<DealerTypeValue, string> =
  Object.fromEntries(DEALER_TYPE_OPTIONS.map((o) => [o.value, o.label])) as Record<
    DealerTypeValue,
    string
  >;

/** Narrow an arbitrary stored value to a known dealer type, or null. */
export function normalizeDealerType(
  value: string | null | undefined,
): DealerTypeValue | null {
  const v = (value || "").trim().toLowerCase();
  return (DEALER_TYPES as readonly string[]).includes(v)
    ? (v as DealerTypeValue)
    : null;
}

/**
 * Display label for a stored dealer_type. Applications created before E-202 —
 * and any unrecognised value — fall back to `fallback` rather than rendering a
 * raw slug at the admin.
 */
export function dealerTypeLabel(
  value: string | null | undefined,
  fallback = "Not specified",
): string {
  const key = normalizeDealerType(value);
  return key ? DEALER_TYPE_LABELS[key] : fallback;
}
