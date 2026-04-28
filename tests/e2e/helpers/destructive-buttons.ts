/**
 * Single source of truth for what the button sweep AND the prod-flow specs
 * refuse to click against crm.itarang.com without an explicit second opt-in
 * (E2E_PROD_MUTATIONS=1).
 *
 * Match by accessible name (aria-label > text content > title). Anything that
 * burns external credit, sends real customer messages, moves money, or creates
 * a real Supabase auth user belongs here.
 */

export const DESTRUCTIVE_BUTTONS: RegExp[] = [
  // State-mutating verbs
  /^delete/i,
  /^remove/i,
  /^reject/i,
  /^cancel\s+(application|agreement|onboarding)/i,

  // Outbound communications
  /^send\s+(sms|otp|notification|email|invitation|whatsapp)/i,
  /^trigger\s+(call|sms)/i,
  /^start\s+call/i,
  /^dial/i,

  // Money movement
  /razorpay/i,
  /^charge/i,
  /^pay\s+now/i,
  /create\s+payment/i,

  // Approval / auth-user creation
  /^approve$/i,
  /final\s+approve|finalize/i,
  /^issue\s+credentials/i,

  // Third-party esign / KYC credit burn
  /initiate\s+(agreement|esign|kyc)/i,
  /refresh\s+agreement/i,
  /verify\s+(pan|aadhaar|bank|rc|gst)/i,
  /pull\s+cibil/i,
];

/** True if the button label looks destructive enough to skip on a sweep. */
export function isDestructive(buttonName: string): boolean {
  const trimmed = buttonName.trim();
  if (!trimmed) return false;
  return DESTRUCTIVE_BUTTONS.some((rx) => rx.test(trimmed));
}
