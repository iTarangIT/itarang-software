import { db } from "@/lib/db";
import { accounts, dealerOnboardingApplications } from "@/lib/db/schema";
import { eq, inArray } from "drizzle-orm";
import { addressesMatch, type AddressParts } from "./address-match";

type Application = typeof dealerOnboardingApplications.$inferSelect;
type Account = typeof accounts.$inferSelect;

export type DuplicateFlag = "none" | "branch" | "duplicate" | "pan-mismatch";

export type ExistingAccountSummary = {
  dealerCode: string;
  companyName: string | null;
  pan: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
};

export type DuplicateClassification = {
  conflict: DuplicateFlag;
  existing: ExistingAccountSummary | null;
  message: string | null;
};

const CLASSIFIED_CLEAN: DuplicateClassification = {
  conflict: "none",
  existing: null,
  message: null,
};

function normalizePan(value: string | null | undefined): string {
  return (value || "").trim().toUpperCase();
}

function normalizeGstin(value: string | null | undefined): string {
  return (value || "").trim().toUpperCase();
}

function applicationAddress(application: Application): AddressParts {
  const raw =
    (application.businessAddress as Record<string, any> | null | undefined) ||
    null;
  if (!raw) return {};
  return {
    line1: raw.line1 || raw.address || null,
    line2: raw.line2 || null,
    city: raw.city || null,
    state: raw.state || null,
    pincode: raw.pincode || null,
  };
}

function accountAddress(account: Account): AddressParts {
  return {
    line1: account.address_line1,
    line2: account.address_line2,
    city: account.city,
    state: account.state,
    pincode: account.pincode,
  };
}

function accountSummary(account: Account): ExistingAccountSummary {
  return {
    dealerCode: account.id,
    companyName: account.business_entity_name,
    pan: account.pan,
    addressLine1: account.address_line1,
    city: account.city,
    state: account.state,
    pincode: account.pincode,
  };
}

/**
 * Classify a conflict between an application and an existing account that
 * already owns the same GSTIN. Pure function — no DB access.
 */
export function classifyConflictAgainstAccount(
  application: Application,
  existing: Account
): DuplicateClassification {
  const appPan = normalizePan(application.panNumber);
  const acctPan = normalizePan(existing.pan);

  if (appPan && acctPan && appPan !== acctPan) {
    return {
      conflict: "pan-mismatch",
      existing: accountSummary(existing),
      message: `GSTIN already registered to a different PAN (${acctPan}). Please verify before approving.`,
    };
  }

  const sameAddress = addressesMatch(
    applicationAddress(application),
    accountAddress(existing)
  );

  if (sameAddress) {
    return {
      conflict: "duplicate",
      existing: accountSummary(existing),
      message: `Duplicate dealer — account ${existing.id} already exists with the same GSTIN, PAN, and address.`,
    };
  }

  return {
    conflict: "branch",
    existing: accountSummary(existing),
    message: `This GSTIN already belongs to ${existing.business_entity_name || existing.id} (${existing.id}). Addresses differ — approving will link this dealer as an additional location under the existing legal entity.`,
  };
}

/**
 * Full async classification — fetches the existing account by GSTIN and
 * delegates to `classifyConflictAgainstAccount`. Used by:
 *   - approve route (single-dealer check)
 *   - duplicate-check GET endpoint
 */
export async function classifyGstinConflict(
  application: Application
): Promise<DuplicateClassification> {
  const gstin = normalizeGstin(application.gstNumber);
  if (!gstin) return CLASSIFIED_CLEAN;

  // If the application is itself already approved as a branch (or shares a
  // dealer_code with the matching account), don't re-flag it.
  const rows = await db
    .select()
    .from(accounts)
    .where(eq(accounts.gstin, gstin))
    .limit(1);

  const existing = rows[0];
  if (!existing) return CLASSIFIED_CLEAN;

  // If the matching account IS this application's own dealer row (via
  // dealerCode), skip — it's a re-approval / already-linked case.
  if (application.dealerCode && existing.id === application.dealerCode) {
    return CLASSIFIED_CLEAN;
  }

  return classifyConflictAgainstAccount(application, existing);
}

/**
 * Batch classifier — for the admin queue list. Accepts a list of
 * applications and pre-loads all matching `accounts` in ONE query so the
 * caller can classify per-row without N+1 fetches.
 */
export async function classifyApplicationsBatch(
  applications: Pick<
    Application,
    "id" | "gstNumber" | "panNumber" | "businessAddress" | "dealerCode"
  >[]
): Promise<Map<string, DuplicateClassification>> {
  const result = new Map<string, DuplicateClassification>();

  const gstins = Array.from(
    new Set(
      applications
        .map((a) => normalizeGstin(a.gstNumber))
        .filter((g) => g.length > 0)
    )
  );

  if (gstins.length === 0) {
    for (const app of applications) result.set(app.id, CLASSIFIED_CLEAN);
    return result;
  }

  const accountRows = await db
    .select()
    .from(accounts)
    .where(inArray(accounts.gstin, gstins));

  const accountByGstin = new Map<string, Account>();
  for (const row of accountRows) {
    const key = normalizeGstin(row.gstin);
    if (!key) continue;
    if (!accountByGstin.has(key)) accountByGstin.set(key, row);
  }

  for (const app of applications) {
    const gstin = normalizeGstin(app.gstNumber);
    if (!gstin) {
      result.set(app.id, CLASSIFIED_CLEAN);
      continue;
    }

    const existing = accountByGstin.get(gstin);
    if (!existing) {
      result.set(app.id, CLASSIFIED_CLEAN);
      continue;
    }

    if (app.dealerCode && existing.id === app.dealerCode) {
      result.set(app.id, CLASSIFIED_CLEAN);
      continue;
    }

    result.set(
      app.id,
      classifyConflictAgainstAccount(app as Application, existing)
    );
  }

  return result;
}
