/**
 * nbfc-loop.setup-personas.ts — Phase 0.1 setup project.
 *
 * Reads docs/nbfc/personas.json and, for every persona, performs a real
 * Supabase login through the /login page (mirrors tests/e2e/global.setup.ts
 * exactly so we don't fork the auth flow), then writes the resulting
 * cookies + localStorage to tests/.auth/<persona>.json.
 *
 * The headed/UI/API projects in nbfc-loop.config.ts depend on this project
 * via `dependencies: ['setup-personas']`, replacing the prior single-role
 * sales_head storage state — that's how RBAC-gated tests will run as the
 * right user instead of the same fallback admin every time.
 *
 * Password resolution (must match seed_personas.py):
 *   $E2E_<PERSONA_UPPER>_PASSWORD overrides $E2E_TEST_PASSWORD fallback.
 *
 * If a persona lacks both env vars, that persona's setup test fails loud
 * — that's the cue to add the key in keys/sandbox.env.
 */

import { test as setup, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

interface PersonaRecord {
  persona_id: string;
  role: string;
  email: string;
  storage_state_path: string;
  can_act_on: ReadonlyArray<string>;
  password_env_key?: string;
  rbac_ui_gated?: boolean;
}

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUTH_DIR = path.join(REPO_ROOT, 'tests', '.auth');
const PERSONAS_PATH = path.join(REPO_ROOT, 'docs', 'nbfc', 'personas.json');

fs.mkdirSync(AUTH_DIR, { recursive: true });

function loadPersonas(): PersonaRecord[] {
  if (!fs.existsSync(PERSONAS_PATH)) {
    throw new Error(
      `[setup-personas] ${PERSONAS_PATH} missing — run \`bash ~/.claude/skills/nbfc/scripts/seed_personas.sh\` first`,
    );
  }
  const arr = JSON.parse(fs.readFileSync(PERSONAS_PATH, 'utf8'));
  if (!Array.isArray(arr)) {
    throw new Error(`[setup-personas] ${PERSONAS_PATH} is not a JSON array`);
  }
  return arr;
}

function resolvePassword(persona: PersonaRecord): string | undefined {
  const key = persona.password_env_key ?? `E2E_${persona.persona_id.toUpperCase()}_PASSWORD`;
  return process.env[key] ?? process.env.E2E_TEST_PASSWORD;
}

const personas = loadPersonas();

if (personas.length === 0) {
  setup('seed personas json is empty', async () => {
    throw new Error(
      '[setup-personas] docs/nbfc/personas.json is empty. Run seed_personas.sh first.',
    );
  });
}

for (const persona of personas) {
  setup(`authenticate persona: ${persona.persona_id}`, async ({ page }) => {
    const password = resolvePassword(persona);
    if (!password) {
      throw new Error(
        `[setup-personas] no password for ${persona.persona_id}. ` +
          `Set ${persona.password_env_key ?? `E2E_${persona.persona_id.toUpperCase()}_PASSWORD`} ` +
          `or E2E_TEST_PASSWORD in $NBFC_ENV_FILE.`,
      );
    }

    await page.goto('/login');
    await page.locator('input[name="email"]').fill(persona.email);
    await page.locator('input[name="password"]').fill(password);
    // Mirror global.setup.ts: the decorative <img> over the form intercepts
    // hit-tests, so force the click.
    await page.getByRole('button', { name: /sign in/i }).click({ force: true });

    // Allow a successful redirect *or* a deterministic failure mode (e.g.
    // unverified user) so we surface a real error and don't time out.
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
    await expect(page).not.toHaveURL(/\/change-password/);

    const outPath = path.isAbsolute(persona.storage_state_path)
      ? persona.storage_state_path
      : path.join(REPO_ROOT, persona.storage_state_path);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.context().storageState({ path: outPath });
  });
}
