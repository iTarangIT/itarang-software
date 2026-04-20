import "dotenv/config";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

import { eq, ne } from "drizzle-orm";
import { db } from "../src/lib/db";
import {
  users,
  dealerOnboardingApplications,
} from "../src/lib/db/schema";
import { supabaseAdmin } from "../src/lib/supabase/admin";

// Shared classifier used by audit-dealer-sync.ts and repair-dealer-sync.ts.
// All exports live here so both scripts agree on the bucket definitions.

export type CategoryCode = "A" | "B" | "C" | "D" | "E" | "F";

export const CATEGORY_LABEL: Record<CategoryCode, string> = {
  A: "healthy (both sides match)",
  B: "soft drift (auth metadata != RDS)",
  C: "hard mismatch (same email, different ids)",
  D: "auth orphan (RDS users row, no Auth)",
  E: "rds orphan (Auth user, no RDS row)",
  F: "pre-approval (application only, no user)",
};

export type RdsUser = {
  id: string;
  email: string;
  role: string;
  dealer_id: string | null;
};

export type AuthUser = {
  id: string;
  email: string;
  metadata: Record<string, unknown>;
};

export type AppRow = {
  ownerEmail: string;
  onboardingStatus: string;
};

export type DealerEntry = {
  email: string;
  category: CategoryCode;
  rds: RdsUser | null;
  auth: AuthUser | null;
  app: AppRow | null;
};

export function printEnvBanner(mode: string) {
  const dbUrl = process.env.DATABASE_URL || "(unset)";
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "(unset)";
  console.log("DATABASE_URL :", dbUrl.replace(/:[^:@]+@/, ":****@"));
  console.log("SUPABASE_URL :", supaUrl);
  console.log("Mode         :", mode);
  console.log("");
}

export async function loadDealerRds(): Promise<RdsUser[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      dealer_id: users.dealer_id,
    })
    .from(users)
    .where(eq(users.role, "dealer"));
  return rows;
}

export async function loadOpenApplications(): Promise<AppRow[]> {
  const rows = await db
    .select({
      ownerEmail: dealerOnboardingApplications.ownerEmail,
      onboardingStatus: dealerOnboardingApplications.onboardingStatus,
    })
    .from(dealerOnboardingApplications)
    .where(ne(dealerOnboardingApplications.onboardingStatus, "approved"));
  return rows
    .filter((r): r is { ownerEmail: string; onboardingStatus: string } =>
      typeof r.ownerEmail === "string" && r.ownerEmail.length > 0,
    )
    .map((r) => ({
      ownerEmail: r.ownerEmail.toLowerCase(),
      onboardingStatus: r.onboardingStatus,
    }));
}

// Paginate through every Supabase Auth user. Existing scripts only read page 1,
// which is exactly the bug that lets orphans slip past the purge.
export async function loadAllAuthUsers(): Promise<AuthUser[]> {
  const perPage = 1000;
  const out: AuthUser[] = [];
  let page = 1;
  while (true) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage,
    });
    if (error) {
      throw new Error(`listUsers page ${page} failed: ${error.message}`);
    }
    for (const u of data.users) {
      if (!u.email) continue;
      out.push({
        id: u.id,
        email: u.email.toLowerCase(),
        metadata: (u.user_metadata || {}) as Record<string, unknown>,
      });
    }
    if (data.users.length < perPage) break;
    page += 1;
  }
  return out;
}

export function classify(
  rdsList: RdsUser[],
  authList: AuthUser[],
  appList: AppRow[],
): DealerEntry[] {
  const rdsEmails = new Set(rdsList.map((r) => r.email.toLowerCase()));

  // Only consider Auth users that are dealer-linked:
  //   - metadata.role === 'dealer', OR
  //   - their email matches a dealer RDS row (catches C where metadata was wiped).
  const authRelevant = authList.filter((a) => {
    const role = typeof a.metadata.role === "string" ? a.metadata.role : null;
    return role === "dealer" || rdsEmails.has(a.email);
  });

  type Bucket = { rds: RdsUser | null; auth: AuthUser | null; app: AppRow | null };
  const byEmail = new Map<string, Bucket>();
  const ensure = (email: string): Bucket => {
    const key = email.toLowerCase();
    let b = byEmail.get(key);
    if (!b) {
      b = { rds: null, auth: null, app: null };
      byEmail.set(key, b);
    }
    return b;
  };

  for (const r of rdsList) ensure(r.email).rds = r;
  for (const a of authRelevant) ensure(a.email).auth = a;
  for (const app of appList) ensure(app.ownerEmail).app = app;

  const entries: DealerEntry[] = [];
  for (const [email, b] of byEmail.entries()) {
    let category: CategoryCode;
    if (b.rds && b.auth) {
      if (b.rds.id !== b.auth.id) {
        category = "C";
      } else {
        const metaRole =
          typeof b.auth.metadata.role === "string"
            ? b.auth.metadata.role
            : null;
        const metaDealerCode =
          typeof b.auth.metadata.dealer_code === "string"
            ? b.auth.metadata.dealer_code
            : null;
        const metadataMatches =
          metaRole === "dealer" && metaDealerCode === b.rds.dealer_id;
        category = metadataMatches ? "A" : "B";
      }
    } else if (b.rds && !b.auth) {
      category = "D";
    } else if (!b.rds && b.auth) {
      category = "E";
    } else if (b.app) {
      category = "F";
    } else {
      // Shouldn't happen — no rds, no auth, no app — skip.
      continue;
    }
    entries.push({
      email,
      category,
      rds: b.rds,
      auth: b.auth,
      app: b.app,
    });
  }

  entries.sort((x, y) => {
    if (x.category !== y.category) return x.category.localeCompare(y.category);
    return x.email.localeCompare(y.email);
  });
  return entries;
}

export function groupByCategory(
  entries: DealerEntry[],
): Record<CategoryCode, DealerEntry[]> {
  const out: Record<CategoryCode, DealerEntry[]> = {
    A: [],
    B: [],
    C: [],
    D: [],
    E: [],
    F: [],
  };
  for (const e of entries) out[e.category].push(e);
  return out;
}
