/**
 * Prod-only global teardown. Runs after every chromium-prod invocation. Soft-
 * deletes rows whose names carry the [E2E] tag with the current runId.
 *
 * Hard rules:
 *   - Never deletes anything outside the [E2E]-prefixed namespace.
 *   - Cannot remove Supabase auth users from a teardown phase reliably (admin
 *     SDK requires SERVICE_ROLE_KEY) — those are *logged* for manual cleanup.
 */

import dotenv from 'dotenv';
import path from 'node:path';
import postgres from 'postgres';
import { clearRunId, currentRunId, PROD_TAG } from './helpers/prod-namespace';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env.test.local'), override: true });

export default async function globalTeardown() {
  // Re-assert the safety gate inside teardown — if someone toggled the env
  // mid-run we still refuse to delete anything outside prod context.
  if (process.env.E2E_ALLOW_PROD !== '1') {
    console.log('[teardown] E2E_ALLOW_PROD!=1 — skipping prod cleanup');
    return;
  }
  if (!process.env.DATABASE_URL) {
    console.warn('[teardown] DATABASE_URL not set — skipping prod cleanup');
    return;
  }

  const runId = currentRunId();
  const tagPrefix = PROD_TAG;
  console.log(`[teardown] starting prod cleanup for runId=${runId}`);

  const sql = postgres(process.env.DATABASE_URL, { ssl: 'require', prepare: false });

  try {
    // dealer_leads — keyed by dealer_name LIKE '[E2E]%' AND containing runId
    const dealerLeads = await sql<{ id: string; dealer_name: string }[]>`
      SELECT id, dealer_name FROM dealer_leads
      WHERE dealer_name LIKE ${tagPrefix + '%'} AND dealer_name LIKE ${'%' + runId + '%'}
    `;
    console.log(`[teardown] dealer_leads matched: ${dealerLeads.length}`);
    for (const row of dealerLeads) {
      await sql`DELETE FROM dealer_leads WHERE id = ${row.id}`;
      console.log(`  deleted dealer_lead ${row.id} (${row.dealer_name})`);
    }

    // leads (customer leads, used by KYC review path)
    const leads = await sql<{ id: string; full_name: string }[]>`
      SELECT id, full_name FROM leads
      WHERE full_name LIKE ${tagPrefix + '%'} AND full_name LIKE ${'%' + runId + '%'}
    `;
    console.log(`[teardown] leads matched: ${leads.length}`);
    for (const row of leads) {
      await sql`DELETE FROM leads WHERE id = ${row.id}`;
      console.log(`  deleted lead ${row.id} (${row.full_name})`);
    }

    // dealer onboarding applications — company_name carries the prefix
    const apps = await sql<{ id: string; company_name: string; owner_email: string | null }[]>`
      SELECT id, company_name, owner_email FROM dealer_onboarding_applications
      WHERE company_name LIKE ${tagPrefix + '%'} AND company_name LIKE ${'%' + runId + '%'}
    `;
    console.log(`[teardown] dealer_onboarding_applications matched: ${apps.length}`);
    for (const app of apps) {
      await sql`DELETE FROM dealer_onboarding_documents WHERE application_id = ${app.id}`;
      await sql`DELETE FROM dealer_onboarding_applications WHERE id = ${app.id}`;
      console.log(`  deleted onboarding application ${app.id} (${app.company_name})`);
    }

    const orphanAuthEmails = apps
      .map((a) => a.owner_email)
      .filter((e): e is string => !!e && e.includes('e2e+'));
    if (orphanAuthEmails.length) {
      console.log(
        `[teardown] LEAVING BEHIND ${orphanAuthEmails.length} Supabase auth users (manual cleanup needed):\n  ${orphanAuthEmails.join('\n  ')}`,
      );
    }
  } catch (err) {
    console.error('[teardown] error:', (err as Error).message);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
    clearRunId();
    console.log('[teardown] done');
  }
}
