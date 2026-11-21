// Sarvam documents HMAC signing only for saved webhook configs (campaigns,
// deployments), not for instant outbound (handoff spec, unverified point 2).
// So the call-end webhook is authenticated by a long random token we put in
// the webhook URL at trigger time and check on receipt.

import { timingSafeEqual } from "node:crypto";

/** Constant-time compare of the received token against SARVAM_WEBHOOK_TOKEN. Pure. */
export function sarvamWebhookTokenValid(
  received: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const want = (expected ?? "").trim();
  const got = (received ?? "").trim();
  // An unset secret must never accept everything.
  if (!want || !got) return false;
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(want, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
