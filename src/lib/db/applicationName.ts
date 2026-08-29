/**
 * The `application_name` every Postgres connection from this process announces.
 *
 * WHY. /operations/database groups pg_stat_activity by application_name to show
 * where connections come from. Without this, every connection this codebase
 * opens reports the driver's default — `postgres.js` — so the attribution table
 * read, verbatim, `postgres.js × 26` against a ceiling of 79 slots. The sandbox
 * web server, the BullMQ worker and any developer laptop pointed at the shared
 * RDS all collapse into that one row, which is exactly the question an operator
 * is asking when they open the page.
 *
 * NO INVENTED NAMES. This returns a name only when the process genuinely knows
 * one, in this order:
 *
 *   1. OPS_APP_NAME — declared in the `env:` block of ecosystem.prod.config.js
 *      and ecosystem.sandbox.config.js, where it sits beside the pm2 `name:`
 *      it copies. THIS IS THE PRIMARY PATH. It is declared rather than sniffed
 *      because pm2 is not a dependency of this repo, so nothing here can prove
 *      what pm2 injects.
 *   2. PGAPPNAME — the standard libpq variable. postgres.js already uses it as
 *      its own default (`node_modules/postgres/src/index.js:485`:
 *      `application_name: env.PGAPPNAME || 'postgres.js'`), which means any
 *      pool in the process that does NOT go through this module already picks
 *      it up. Honouring it here too keeps every pool in one process reporting
 *      the same name instead of two.
 *   3. pm2's own process name. Best-effort, and gated on `pm_id` also being
 *      present because `name` on its own is a common variable that could be
 *      anything. Kept so a box whose ecosystem file has not been updated yet
 *      still gets attribution.
 *
 * Otherwise it returns undefined and the connection keeps the driver default —
 * which the dashboard then labels as "unnamed", not as an identity. A guessed
 * name on an ops dashboard is worse than a generic one: it is a wrong answer
 * that looks like a right one.
 *
 * Postgres truncates application_name at NAMEDATALEN-1 (63 bytes) and rejects
 * control characters, so the value is sanitised and clipped here rather than
 * failing the connection.
 */

const MAX_LENGTH = 63;

/**
 * Where a resolved name came from, or why there is none.
 *
 * Rendered on /operations/database so an operator can tell a deploy that has
 * not picked up the env change from one where the name genuinely cannot be
 * determined — the difference between "not applied yet" and "nothing to
 * apply", which is exactly what was unanswerable when the table showed only
 * `postgres.js`.
 */
export type ApplicationNameSource =
  | "OPS_APP_NAME"
  | "PGAPPNAME"
  | "pm2"
  | "none";

function sanitise(raw: string): string | undefined {
  // Printable ASCII only. Postgres silently replaces anything else, which
  // would make the dashboard's grouping key differ from what we set.
  const cleaned = raw
    .replace(/[^\x20-\x7e]/g, "")
    .trim()
    .slice(0, MAX_LENGTH);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * The name this process should announce, or undefined when it does not know.
 *
 * Read at connection time rather than at module load: Next.js dev reloads
 * .env.local without restarting Node, and src/lib/db/iot.ts already rebuilds
 * its pool when the connection string changes.
 */
export function resolveApplicationName(): {
  name: string | undefined;
  source: ApplicationNameSource;
} {
  const declared = sanitise(process.env.OPS_APP_NAME ?? "");
  if (declared) return { name: declared, source: "OPS_APP_NAME" };

  const libpq = sanitise(process.env.PGAPPNAME ?? "");
  if (libpq) return { name: libpq, source: "PGAPPNAME" };

  // pm2 injects both of these into the app's environment. Checked last, and
  // only as a pair — see the header for why this is best-effort.
  if (process.env.pm_id != null && process.env.name) {
    const fromPm2 = sanitise(process.env.name);
    if (fromPm2) return { name: fromPm2, source: "pm2" };
  }

  return { name: undefined, source: "none" };
}

export function applicationName(): string | undefined {
  return resolveApplicationName().name;
}

/** Which input supplied the name, for the dashboard's diagnostic line. */
export function applicationNameSource(): ApplicationNameSource {
  return resolveApplicationName().source;
}

/**
 * Application names that are a DRIVER DEFAULT rather than an identity.
 *
 * `postgres.js` is what every unnamed postgres.js pool reports, so a row
 * carrying it means "this process declared nothing", not "this process is
 * called postgres.js". The dashboard renders these as unnamed and leans on the
 * client address instead. `PostgreSQL JDBC Driver` is AWS RDS's own management
 * tooling connecting to `rdsadmin` — not ours, and not renameable by us.
 */
const DRIVER_DEFAULT_NAMES = new Set([
  "postgres.js",
  "node-postgres",
  "PostgreSQL JDBC Driver",
  "(unnamed)",
  "",
]);

export function isDriverDefaultName(application: string | null): boolean {
  return application == null || DRIVER_DEFAULT_NAMES.has(application.trim());
}

/**
 * postgres.js connection options carrying the name, or an empty object when
 * there is no name to announce.
 *
 * Spread into the client options so that "we don't know" produces no key at
 * all rather than `application_name: undefined`, which the driver would send
 * as an empty string and pg_stat_activity would report as `(unnamed)` —
 * indistinguishable from a backend that genuinely set nothing.
 */
export function applicationNameOption(): {
  connection?: { application_name: string };
} {
  const name = applicationName();
  return name ? { connection: { application_name: name } } : {};
}
