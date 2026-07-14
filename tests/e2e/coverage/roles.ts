/**
 * Single source of truth for which roles the suite authenticates, shared by
 * global.setup.ts (which logs in + writes storage state) and the smoke spec
 * (which reads the storage state back).
 *
 * Credentials resolve from env first (E2E_<ROLE>_EMAIL / E2E_<ROLE>_PASSWORD),
 * falling back to the long-standing seeded sandbox users where we know them
 * (see scripts/seed-*-user.js). A role with no resolvable password is simply
 * skipped — its smoke tests report as Skipped rather than failing the run.
 */

export type RoleAuth = {
  role: string;
  /** Landing dashboard path — used to sanity-check the login redirect. */
  dashboard: string;
  email?: string;
  password?: string;
  /** storageState filename under tests/.auth/ */
  stateFile: string;
};

function env(role: string, field: 'EMAIL' | 'PASSWORD'): string | undefined {
  return process.env[`E2E_${role.toUpperCase()}_${field}`];
}

/**
 * Sandbox roles. `password` may be undefined (env-only) — global.setup skips
 * those and the smoke spec skips any role whose state file was never written.
 */
export const SANDBOX_ROLES: RoleAuth[] = [
  {
    role: 'ceo',
    dashboard: '/ceo',
    email: env('ceo', 'EMAIL') ?? 'ceo.itarang@gmail.com',
    password: env('ceo', 'PASSWORD') ?? 'password',
    stateFile: 'ceo.json',
  },
  {
    role: 'sales_head',
    dashboard: '/sales-head',
    email: env('sales_head', 'EMAIL') ?? 'anirudh@itarang.com',
    password: env('sales_head', 'PASSWORD') ?? process.env.E2E_TEST_PASSWORD,
    stateFile: 'sales_head.json',
  },
  {
    role: 'dealer',
    dashboard: '/dealer-portal',
    email: env('dealer', 'EMAIL') ?? 'dealer@itarang.com',
    password: env('dealer', 'PASSWORD') ?? 'password',
    stateFile: 'dealer.json',
  },
  {
    role: 'asm',
    dashboard: '/asm',
    email: env('asm', 'EMAIL') ?? 'asm.itarang@gmail.com',
    password: env('asm', 'PASSWORD'), // seeded pw is 'password' but env-gated by default
    stateFile: 'asm.json',
  },
  // Purely env-driven roles — provide creds in .env.test.local to include them.
  ...(['business_head', 'finance_controller', 'sales_manager', 'sales_executive',
    'inventory_manager', 'service_engineer', 'sales_order_manager', 'admin'] as const).map(
    (role): RoleAuth => ({
      role,
      dashboard: `/${role.replace(/_/g, '-')}`,
      email: env(role, 'EMAIL'),
      password: env(role, 'PASSWORD'),
      stateFile: `${role}.json`,
    }),
  ),
];

/** The role whose session can reach every dashboard (CEO bypasses the role-mismatch redirect). */
export const SUPER_ROLE = 'ceo';

export function resolvableRoles(roles: RoleAuth[] = SANDBOX_ROLES): RoleAuth[] {
  return roles.filter((r) => r.email && r.password);
}
