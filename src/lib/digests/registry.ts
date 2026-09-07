/**
 * Every registered digest (E-288).
 *
 * Adding one is two steps: write a descriptor in ./kinds, list it here. The
 * ticker, the cron route, the settings API, the settings form and the verifier
 * all iterate this list, so a new kind arrives complete — including its own
 * ledger rows, its own claim, and its own settings blob.
 *
 * The one thing a new kind still needs by hand is a SIDEBAR ENTRY and a page
 * route at its `settingsHref`. `digest-registry.contract.test.ts` asserts both
 * exist, so a kind added here without them fails the build rather than shipping a
 * settings screen nobody can reach.
 */

import { dealerValidationDigest } from "./kinds/dealer-validation";
import { kycReviewDigest } from "./kinds/kyc-review";
import type { DigestKindDescriptor, DigestKindId } from "./types";

export const DIGEST_KINDS: DigestKindDescriptor[] = [
  dealerValidationDigest,
  kycReviewDigest,
];

export function digestKind(id: string): DigestKindDescriptor | null {
  return DIGEST_KINDS.find((k) => k.id === id) ?? null;
}

export function isDigestKindId(id: string): id is DigestKindId {
  return DIGEST_KINDS.some((k) => k.id === id);
}

export const DIGEST_KIND_IDS = DIGEST_KINDS.map((k) => k.id);
