// Helpers for reading/writing the jsonb `provider_raw_response` column on
// dealer_onboarding_applications without clobbering the agreement config that
// the dealer-submit path stores under `.agreement`.
//
// Several admin routes (initiate-agreement, refresh-agreement, cancel-agreement)
// write Digio's raw document payload into this column. Digio's body does not
// contain an `.agreement` sub-key, so a naive replace would drop the signer /
// MOU / vehicle-type fields that the admin detail GET reads back to render the
// page and to build the Reinitiate payload.

type AnyRec = Record<string, unknown>;

function toObject(value: unknown): AnyRec {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as AnyRec;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as AnyRec;
      }
    } catch {
      // fall through
    }
  }
  return {};
}

/**
 * Merge a Digio response into the existing providerRawResponse while
 * preserving the `agreement` (and `submissionSnapshot`) sub-keys written at
 * submission time. Pass the existing column value and the new response body;
 * returns the object to persist.
 */
export function mergeProviderRawResponse(existing: unknown, next: unknown): AnyRec {
  const existingObj = toObject(existing);
  const nextObj = toObject(next);
  const merged: AnyRec = { ...existingObj, ...nextObj };

  // Preserve agreement config (populated by save/submit) across admin Digio
  // actions. Prefer the existing value; fall back to whatever the response
  // happens to carry.
  if (existingObj.agreement !== undefined) {
    merged.agreement = existingObj.agreement;
  }
  if (existingObj.submissionSnapshot !== undefined) {
    merged.submissionSnapshot = existingObj.submissionSnapshot;
  }
  return merged;
}
