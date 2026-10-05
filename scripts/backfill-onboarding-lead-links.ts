/**
 * Tracker IDs 5, 67, 69 (handover P1-1, P1-4, P1-6) — backfill the
 * onboarding → lead links and the account origin record for dealers that were
 * onboarded BEFORE those were written at approval time.
 *
 * Two passes:
 *
 *   (a) LEAD LINKS. Every dealer_onboarding_applications row that has neither
 *       an originating_dealer_lead_id nor a dealer_leads back-reference is
 *       matched to a lead BY PHONE — the owner's, the WhatsApp and the contact
 *       number, in that order (linkToLead.ts candidatePhones +
 *       leadSource.findExistingLeadByPhone, the shared last-10-digit duplicate
 *       check). With --commit this calls linkOnboardingToLead(), which writes
 *       only empty columns and never steals a lead another application holds.
 *       An application no lead matches is a DIRECT onboarding and stays unlinked.
 *
 *   (b) ACCOUNT ORIGIN. Every `accounts` row gets an account_ownership row:
 *       came_through 'lead' when its application (the OLDEST
 *       dealer_onboarding_applications row with dealer_code = accounts.id) is
 *       linked to a lead, else 'direct'; onboarded_by = the application's
 *       owner_id, else its onboarding_operator_id; and the source lead /
 *       application ids — via recordAccountOrigin(), which only fills what is
 *       still empty.
 *
 * NEVER SETS AN OWNER. account_ownership.owner_user_id stays NULL: a person
 * assigns owners from the Accounts tab. That is the "nothing is assigned
 * automatically" rule, and a backfill is not an exception to it.
 *
 * DRY RUN BY DEFAULT. Nothing is written without --commit; the dry run makes
 * the same phone lookups and prints what it WOULD link. A dry-run link can
 * still be refused at commit time if another application claims the lead
 * first — the summary says how many candidates are already claimed.
 *
 *   node --import tsx --env-file=.env.local scripts/backfill-onboarding-lead-links.ts            # dry run
 *   node --import tsx --env-file=.env.local scripts/backfill-onboarding-lead-links.ts --commit
 *
 * Options:
 *   --commit    actually write (default is a rehearsal)
 *   --verbose   print one line per application / account
 *
 * Requires E-321 (drizzle/E-321_account_ownership_list_price.sql). Aborts
 * without touching anything when its tables are missing.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { hasAccountOwnershipTables } from "@/lib/accounts/tables";
import { recordAccountOrigin, type CameThrough } from "@/lib/accounts/ownership";
import { candidatePhones, linkOnboardingToLead } from "@/lib/onboarding/linkToLead";
import { findExistingLeadByPhone } from "@/lib/leads/leadSource";

const argv = process.argv.slice(2);
const COMMIT = argv.includes("--commit");
const VERBOSE = argv.includes("--verbose");

type AppRow = {
  id: string;
  company_name: string | null;
  dealer_code: string | null;
  owner_phone: string | null;
  wa_phone: string | null;
  contact_phone: string | null;
  originating_dealer_lead_id: string | null;
  back_ref_lead_id: string | null;
};

type AccountRow = {
  account_id: string;
  name: string | null;
  app_id: string | null;
  owner_id: string | null;
  operator_id: string | null;
  has_origin: boolean;
};

function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  return ((res as { rows?: T[] })?.rows ?? []) as T[];
}

function pad(s: string | number, n: number): string {
  const t = String(s);
  return t.length >= n ? t : t + " ".repeat(n - t.length);
}

async function main() {
  console.log(`Mode: ${COMMIT ? "COMMIT — writing" : "DRY RUN — nothing is written"}\n`);

  if (!(await hasAccountOwnershipTables())) {
    console.error(
      "E-321 is not applied to this database (account_ownership / account_owner_history /\n" +
        "account_gstins / invoice_account_links missing). Apply\n" +
        "drizzle/E-321_account_ownership_list_price.sql first. Nothing was written.",
    );
    process.exit(2);
  }

  // ── (a) lead links ──────────────────────────────────────────────────────────
  const apps = rowsOf<AppRow>(
    await db.execute(sql`
      SELECT app.id, app.company_name, app.dealer_code,
             app.owner_phone, app.wa_phone, app.contact_phone,
             app.originating_dealer_lead_id,
             (SELECT dl.id FROM dealer_leads dl
               WHERE dl.dealer_onboarding_application_id = app.id
               ORDER BY dl.created_at ASC LIMIT 1) AS back_ref_lead_id
        FROM dealer_onboarding_applications app
       ORDER BY app.created_at ASC
    `),
  );

  /** application id → the lead it is (or would be) linked to. */
  const leadOf = new Map<string, string>();
  let alreadyLinked = 0;
  let linkedByPhone = 0;
  let candidateClaimed = 0;
  let direct = 0;
  const byVia = new Map<string, number>();

  for (const app of apps) {
    const existing = app.originating_dealer_lead_id ?? app.back_ref_lead_id;
    if (existing) {
      alreadyLinked++;
      leadOf.set(app.id, existing);
      continue;
    }

    if (COMMIT) {
      const res = await linkOnboardingToLead(app.id);
      if (res.leadId) {
        leadOf.set(app.id, res.leadId);
        if (res.linked) linkedByPhone++;
        else candidateClaimed++;
        byVia.set(res.via ?? "?", (byVia.get(res.via ?? "?") ?? 0) + 1);
        if (VERBOSE) {
          console.log(
            `  ${res.linked ? "LINKED " : "BACKREF"} ${app.id} (${app.company_name ?? "—"}) → ${res.leadId} via ${res.via}`,
          );
        }
      } else {
        direct++;
        if (VERBOSE) console.log(`  DIRECT  ${app.id} (${app.company_name ?? "—"})`);
      }
      continue;
    }

    // Dry run: the same lookup linkOnboardingToLead makes, without its writes.
    let found: { leadId: string; via: string } | null = null;
    for (const c of candidatePhones(app)) {
      const leadId = await findExistingLeadByPhone(c.phone);
      if (leadId) {
        found = { leadId, via: c.via };
        break;
      }
    }
    if (!found) {
      direct++;
      if (VERBOSE) console.log(`  DIRECT       ${app.id} (${app.company_name ?? "—"})`);
      continue;
    }
    leadOf.set(app.id, found.leadId);
    byVia.set(found.via, (byVia.get(found.via) ?? 0) + 1);
    // linkOnboardingToLead refuses a lead another application already holds
    // (partial UNIQUE index, E-127); say so instead of over-promising.
    const claimed = rowsOf<{ id: string }>(
      await db.execute(sql`
        SELECT id FROM dealer_onboarding_applications
         WHERE originating_dealer_lead_id = ${found.leadId} AND id <> ${app.id}
         LIMIT 1
      `),
    );
    if (claimed.length) candidateClaimed++;
    else linkedByPhone++;
    if (VERBOSE) {
      console.log(
        `  ${claimed.length ? "CLAIMED    " : "WOULD LINK "} ${app.id} (${app.company_name ?? "—"}) → ${found.leadId} via ${found.via}` +
          (claimed.length ? ` (lead already held by ${claimed[0].id})` : ""),
      );
    }
  }

  // ── (b) account origin ──────────────────────────────────────────────────────
  const accs = rowsOf<AccountRow>(
    await db.execute(sql`
      SELECT a.id AS account_id, a.business_entity_name AS name,
             app.id AS app_id, app.owner_id,
             app.onboarding_operator_id::text AS operator_id,
             EXISTS (SELECT 1 FROM account_ownership ao
                      WHERE ao.account_id = a.id AND ao.came_through IS NOT NULL) AS has_origin
        FROM accounts a
        LEFT JOIN LATERAL (
              SELECT x.id, x.owner_id, x.onboarding_operator_id
                FROM dealer_onboarding_applications x
               WHERE x.dealer_code = a.id
               ORDER BY x.created_at ASC
               LIMIT 1
        ) app ON TRUE
       ORDER BY a.created_at ASC
    `),
  );

  let accountsRecorded = 0;
  let accountsAlready = 0;
  let accountsLead = 0;
  let accountsDirect = 0;
  let accountsNoApp = 0;
  for (const a of accs) {
    const leadId = a.app_id ? (leadOf.get(a.app_id) ?? null) : null;
    const cameThrough: CameThrough = leadId ? "lead" : "direct";
    if (!a.app_id) accountsNoApp++;
    if (cameThrough === "lead") accountsLead++;
    else accountsDirect++;
    if (a.has_origin) accountsAlready++;

    if (COMMIT) {
      // Fill-only: an existing row keeps what it has (and its owner, untouched).
      await recordAccountOrigin(a.account_id, {
        onboardedBy: a.owner_id ?? a.operator_id ?? null,
        cameThrough,
        dealerLeadId: leadId,
        applicationId: a.app_id,
      });
    }
    accountsRecorded++;
    if (VERBOSE) {
      console.log(
        `  ${pad(a.account_id, 14)} ${pad(cameThrough, 7)} ${a.has_origin ? "(had origin) " : ""}` +
          `${a.name ?? "—"}${a.app_id ? "" : "  [no onboarding application]"}`,
      );
    }
  }

  // ── summary ─────────────────────────────────────────────────────────────────
  const verb = COMMIT ? "" : "would be ";
  console.log("\n================ SUMMARY ================");
  console.log(`onboarding applications          : ${apps.length}`);
  console.log(`  already linked to a lead       : ${alreadyLinked}`);
  console.log(`  ${pad(verb + "linked by phone", 30)} : ${linkedByPhone}`);
  console.log(`  lead found but already claimed : ${candidateClaimed}`);
  console.log(`  direct (no lead has the phone) : ${direct}`);
  if (byVia.size) {
    console.log(`  matched via                    : ${[...byVia].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  console.log(`accounts                         : ${accs.length}`);
  console.log(`  ${pad(verb + "recorded", 30)} : ${accountsRecorded}`);
  console.log(`  already had an origin          : ${accountsAlready}  (kept — only empty fields are filled)`);
  console.log(`  came through a lead            : ${accountsLead}`);
  console.log(`  direct                         : ${accountsDirect}`);
  console.log(`  with no onboarding application : ${accountsNoApp}`);
  console.log("owners set                       : 0  (never — assign from the Accounts tab)");

  if (!COMMIT) {
    console.log("\nNothing was written. Re-run with --commit to apply.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
