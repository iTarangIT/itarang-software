/**
 * 23 Nov — the dealer check's people (pure rules; DB side in ./dealer-check-settings.ts).
 *
 * Stored in app_settings 'dealer_check_settings' (no migration):
 *   houseApproverIds — iTarang House team logins (users under the house dealer
 *                      code) that may Approve / Change / Reject a dealer check,
 *                      besides the main house login. Set on Admin › House team
 *                      logins ("Can approve").
 *   recipients       — the people told by email and WhatsApp the moment a file
 *                      reaches the dealer check, with a link to act on it
 *                      (Chirag, Anirudh, Admin, Sanchit …). Set by Admin / Sales
 *                      Head on Settings › Dealer check alerts. Each one is a CRM
 *                      user, so the decision is recorded against that person.
 */

export interface DealerCheckRecipient {
  /** The CRM user (users.id) — the decision is recorded as this person. */
  userId: string;
  name: string;
  email: string | null;
  /** 10-digit Indian mobile, or null. */
  whatsapp: string | null;
  emailOn: boolean;
  whatsappOn: boolean;
}

export interface DealerCheckSettings {
  houseApproverIds: string[];
  recipients: DealerCheckRecipient[];
}

export const EMPTY_DEALER_CHECK_SETTINGS: DealerCheckSettings = { houseApproverIds: [], recipients: [] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** "+91 98765-43210" → "9876543210"; anything that is not an Indian mobile → null. */
export function normalizeMobile(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const d = raw.replace(/\D/g, "").slice(-10);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return EMAIL.test(e) ? e : null;
}

/** Whatever is stored (or posted) → a clean settings object. Never throws. */
export function normalizeDealerCheckSettings(raw: unknown): DealerCheckSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const approvers = Array.isArray(o.houseApproverIds) ? o.houseApproverIds : [];
  const houseApproverIds = [...new Set(approvers.filter((x): x is string => typeof x === "string" && UUID.test(x)))];

  const seen = new Set<string>();
  const recipients: DealerCheckRecipient[] = [];
  for (const r of Array.isArray(o.recipients) ? o.recipients : []) {
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    const userId = typeof x.userId === "string" && UUID.test(x.userId) ? x.userId : null;
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    const email = normalizeEmail(x.email);
    const whatsapp = normalizeMobile(x.whatsapp);
    recipients.push({
      userId,
      name: (typeof x.name === "string" ? x.name.trim() : "").slice(0, 120) || "iTarang team",
      email,
      whatsapp,
      emailOn: x.emailOn !== false && !!email,
      whatsappOn: x.whatsappOn !== false && !!whatsapp,
    });
  }
  return { houseApproverIds, recipients: recipients.slice(0, 20) };
}

/** Problems to show on the settings screen before saving (empty = fine). */
export function validateRecipients(recipients: DealerCheckRecipient[]): string[] {
  const out: string[] = [];
  for (const r of recipients) {
    if (!r.emailOn && !r.whatsappOn) out.push(`${r.name}: add an email or a WhatsApp number, or remove them.`);
  }
  return out;
}

// ── "Action taken" notice ─────────────────────────────────────────────────────

export type DealerCheckDecisionWord = "approve" | "change" | "reject";

export function decisionPhrase(decision: DealerCheckDecisionWord, dealerName: string, newDealerName?: string | null): string {
  if (decision === "approve") return `approved the dealer ${dealerName}`;
  if (decision === "change") return `changed the dealer from ${dealerName} to ${newDealerName ?? "another dealer"}`;
  return `rejected the dealer ${dealerName}`;
}

/**
 * Point 5 (23 Nov) — what an approval means, in words a dealer / sales person
 * can't misread: the paperwork is accepted for processing, KYC is NOT approved.
 */
export const PAPERWORK_ACCEPTED_NOTE =
  "iTarang has accepted the paperwork for further processing. This does not mean the KYC is approved yet — the KYC is still under review.";
