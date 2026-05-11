/**
 * seed-personas.ts — idempotent Drizzle helper for the /nbfc skill's
 * Phase 0.1 persona registry.
 *
 * Reads `docs/nbfc/personas.json` (the canonical registry written by
 * `~/.claude/skills/nbfc/scripts/seed_personas.py`) and seeds each persona
 * into the right table:
 *
 *   - admin / sales_* / *_controller / *_manager / service_engineer / dealer
 *     → `users` row with the matching `role`. (Dealer also gets a `dealers`
 *       row so dealer-portal queries by `dealer_id` resolve.) The repo has
 *       no `dealer_users` table — dealers authenticate as `users` rows
 *       carrying `role='dealer'` + `dealer_id`.
 *
 *   - nbfc_tenant_user → `nbfc_users` link row attached to a seeded
 *     `nbfc_tenants` row (slug='e2e-test-nbfc'). The Supabase auth user
 *     itself still lives in `users`.
 *
 * Reuses the postgres-js client pattern from db-seed.ts so we don't fight
 * for the connection pool with other helpers.
 *
 * Idempotency: every persona insert uses ON CONFLICT DO UPDATE on the
 * stable identifying column (users.email, dealers.owner_email,
 * nbfc_tenants.slug, plus the (user_id, tenant_id) composite for nbfc_users).
 * The matching Supabase auth.users row is the responsibility of the
 * Playwright `setup-personas` project — that's the only path that owns a
 * service-role key. This helper writes the public-schema rows the app
 * reads after login.
 */

import path from 'node:path';
import fs from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../../src/lib/db/schema';

export interface PersonaRecord {
  persona_id: string;
  role: string;
  email: string;
  storage_state_path: string;
  can_act_on: ReadonlyArray<'nbfc_tenant' | 'dealer' | 'admin'>;
  password_env_key?: string;
  password_source?: 'specific' | 'fallback' | 'missing';
  rbac_ui_gated?: boolean;
  source?: string;
}

type Client = { db: ReturnType<typeof drizzle>; sql: ReturnType<typeof postgres> };
let _client: Client | null = null;

function getClient(): Client {
  if (_client) return _client;
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error(
      '[seed-personas] DATABASE_URL must be set (source keys/sandbox.env or .env.local first)',
    );
  }
  const sqlClient = postgres(dbUrl, { ssl: 'require', prepare: false });
  const db = drizzle(sqlClient, { schema });
  _client = { db, sql: sqlClient };
  return _client;
}

export async function closeSeedPersonasClient(): Promise<void> {
  if (_client) {
    await _client.sql.end({ timeout: 5 }).catch(() => {});
  }
  _client = null;
}

function repoRoot(): string {
  // helpers/seed-personas.ts → tests/e2e/helpers → repo root
  return path.resolve(__dirname, '..', '..', '..');
}

export function loadPersonas(): PersonaRecord[] {
  const p = path.join(repoRoot(), 'docs', 'nbfc', 'personas.json');
  if (!fs.existsSync(p)) {
    throw new Error(
      `[seed-personas] ${p} missing — run \`bash ~/.claude/skills/nbfc/scripts/seed_personas.sh\` first`,
    );
  }
  const raw = fs.readFileSync(p, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`[seed-personas] ${p} is not a JSON array`);
  }
  return parsed as PersonaRecord[];
}

/**
 * Stable UUID-v5-style namespace prefix for E2E persona ids. We generate
 * deterministic UUIDs by hashing persona_id with the Postgres uuid_generate_v5
 * equivalent inline — but to avoid requiring the extension, we just use a
 * deterministic v4-shaped string built from a sha256 of the persona_id and
 * trim/format it. That keeps the same persona_id stable across re-runs
 * (idempotent), which is the property that matters.
 */
function deterministicUuid(personaId: string): string {
  // Deterministic synthesis: sha256(persona_id) -> formatted as uuid v4.
  const crypto = require('node:crypto') as typeof import('node:crypto');
  const h = crypto.createHash('sha256').update(`nbfc-persona:${personaId}`).digest('hex');
  // Format as 8-4-4-4-12, force version 4 + variant 8.
  const bytes = h.slice(0, 32);
  const v = '4' + bytes.slice(13, 16);
  const var1 = '8' + bytes.slice(17, 20);
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-${v}-${var1}-${bytes.slice(20, 32)}`;
}

async function ensureNbfcTenant(): Promise<string> {
  const { db } = getClient();
  const slug = 'e2e-test-nbfc';
  const existing = await db
    .select({ id: schema.nbfcTenants.id })
    .from(schema.nbfcTenants)
    .where(eq(schema.nbfcTenants.slug, slug))
    .limit(1);
  if (existing.length > 0) return existing[0].id;
  const [row] = await db
    .insert(schema.nbfcTenants)
    .values({
      slug,
      display_name: 'E2E Test NBFC',
      contact_email: 'nbfc_tenant_user@e2e.itarang.local',
      is_active: true,
    } as typeof schema.nbfcTenants.$inferInsert)
    .returning({ id: schema.nbfcTenants.id });
  return row.id;
}

async function ensureDealer(persona: PersonaRecord): Promise<string> {
  const { db } = getClient();
  // Stable key: owner_email = persona.email.
  const existing = await db
    .select({ id: schema.dealers.id, dealer_id: schema.dealers.dealer_id })
    .from(schema.dealers)
    .where(eq(schema.dealers.owner_email, persona.email))
    .limit(1);
  if (existing.length > 0 && existing[0].dealer_id) {
    return existing[0].dealer_id;
  }
  const dealerCode = `DLR-E2E-${persona.persona_id.toUpperCase().slice(0, 16)}`;
  if (existing.length > 0) {
    await db
      .update(schema.dealers)
      .set({ dealer_id: dealerCode, onboarding_status: 'active' })
      .where(eq(schema.dealers.id, existing[0].id));
    return dealerCode;
  }
  await db
    .insert(schema.dealers)
    .values({
      dealer_id: dealerCode,
      company_name: 'E2E Dealer',
      company_type: 'proprietorship',
      owner_email: persona.email,
      owner_name: 'E2E Dealer Owner',
      onboarding_status: 'active',
      finance_enabled: true,
    } as typeof schema.dealers.$inferInsert);
  return dealerCode;
}

async function upsertUser(
  persona: PersonaRecord,
  opts: { dealerCode?: string | null } = {},
): Promise<{ userId: string; email: string }> {
  const { db } = getClient();
  const userId = deterministicUuid(persona.persona_id);

  // ON CONFLICT (email) DO UPDATE — keeps id stable per email if row already
  // exists (e.g. someone seeded earlier with a different deterministic id).
  await db
    .insert(schema.users)
    .values({
      id: userId,
      email: persona.email,
      name: persona.persona_id.replace(/_/g, ' '),
      role: persona.role,
      dealer_id: opts.dealerCode ?? null,
      is_active: true,
      must_change_password: false,
    } as typeof schema.users.$inferInsert)
    .onConflictDoUpdate({
      target: schema.users.email,
      set: {
        role: persona.role,
        dealer_id: opts.dealerCode ?? null,
        is_active: true,
        updated_at: sql`now()`,
      },
    });

  // Resolve the actual id (in case a pre-existing row has a different id).
  const [row] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, persona.email))
    .limit(1);
  return { userId: row?.id ?? userId, email: persona.email };
}

async function linkNbfcUser(userId: string, tenantId: string, role = 'admin'): Promise<void> {
  const { db } = getClient();
  await db
    .insert(schema.nbfcUsers)
    .values({
      user_id: userId,
      tenant_id: tenantId,
      role,
    } as typeof schema.nbfcUsers.$inferInsert)
    .onConflictDoNothing();
}

/**
 * Seed a single persona. Returns the underlying users.id so callers can
 * cross-reference with auth.users when bootstrapping Supabase sessions.
 */
export async function seedPersona(personaId: string): Promise<{ userId: string; email: string }> {
  const personas = loadPersonas();
  const persona = personas.find((p) => p.persona_id === personaId);
  if (!persona) {
    throw new Error(
      `[seed-personas] no persona '${personaId}' in personas.json (have: ${personas
        .map((p) => p.persona_id)
        .join(', ')})`,
    );
  }
  return seedPersonaRecord(persona);
}

async function seedPersonaRecord(
  persona: PersonaRecord,
): Promise<{ userId: string; email: string }> {
  const acts = new Set(persona.can_act_on);

  if (acts.has('dealer')) {
    const dealerCode = await ensureDealer(persona);
    return upsertUser(persona, { dealerCode });
  }

  if (acts.has('nbfc_tenant')) {
    const tenantId = await ensureNbfcTenant();
    const { userId, email } = await upsertUser(persona);
    await linkNbfcUser(userId, tenantId, persona.role);
    return { userId, email };
  }

  // Default: admin-style users table seeding.
  return upsertUser(persona);
}

/** Seed every persona declared in personas.json. Idempotent. */
export async function seedAllPersonas(): Promise<void> {
  const personas = loadPersonas();
  for (const persona of personas) {
    try {
      const { userId } = await seedPersonaRecord(persona);
      // eslint-disable-next-line no-console
      console.log(`[seed-personas] OK  ${persona.persona_id} -> users.id=${userId}`);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[seed-personas] FAIL ${persona.persona_id}:`, (e as Error).message);
      throw e;
    }
  }
  await closeSeedPersonasClient();
}

// Allow `npx tsx tests/e2e/helpers/seed-personas.ts` invocation.
if (require.main === module) {
  seedAllPersonas().then(
    () => process.exit(0),
    (e) => {
      // eslint-disable-next-line no-console
      console.error(e);
      process.exit(1);
    },
  );
}
