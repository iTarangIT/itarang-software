import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applicationName,
  applicationNameOption,
  applicationNameSource,
  isDriverDefaultName,
  resolveApplicationName,
} from "../applicationName";

/**
 * The rules behind connection attribution on /operations/database.
 *
 * The defect: every connection this codebase opened reported the postgres.js
 * driver default, so the attribution table read `postgres.js × 12` across three
 * IPs. Sandbox, production and the worker all run on ONE VPS and reach the same
 * RDS from ONE address, so client_addr cannot separate them — application_name
 * is the only axis that can.
 *
 * The rule that matters most here is the negative one: when nothing declares a
 * name, this must return undefined so the pool keeps the driver default and the
 * page can label it "unnamed". Inventing a plausible name would put a wrong
 * answer on an ops dashboard in the shape of a right one.
 */

const KEYS = ["OPS_APP_NAME", "PGAPPNAME", "pm_id", "name"] as const;

let saved: Partial<Record<(typeof KEYS)[number], string | undefined>>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveApplicationName — precedence", () => {
  it("prefers OPS_APP_NAME, the value declared beside pm2's own `name:`", () => {
    process.env.OPS_APP_NAME = "sandbox-web";
    process.env.PGAPPNAME = "from-libpq";
    process.env.pm_id = "0";
    process.env.name = "from-pm2";
    expect(resolveApplicationName()).toEqual({
      name: "sandbox-web",
      source: "OPS_APP_NAME",
    });
  });

  it("falls back to PGAPPNAME, which postgres.js already uses as its default", () => {
    // Honouring it keeps every pool in one process reporting the same name.
    // Ignoring it would give our explicit clients one name and any pool that
    // does not go through this module another.
    process.env.PGAPPNAME = "itarang-crm-web";
    process.env.pm_id = "0";
    process.env.name = "from-pm2";
    expect(resolveApplicationName()).toEqual({
      name: "itarang-crm-web",
      source: "PGAPPNAME",
    });
  });

  it("falls back to pm2's name, but only when pm_id proves it is really pm2", () => {
    process.env.pm_id = "3";
    process.env.name = "sandbox-worker";
    expect(resolveApplicationName()).toEqual({
      name: "sandbox-worker",
      source: "pm2",
    });
  });

  it("ignores a bare `name` with no pm_id beside it", () => {
    // `name` is a common enough variable to be anything at all.
    process.env.name = "some-unrelated-value";
    expect(applicationName()).toBeUndefined();
    expect(applicationNameSource()).toBe("none");
  });
});

describe("resolveApplicationName — refusing to guess", () => {
  it("returns undefined when nothing declares a name", () => {
    // A developer's `npm run dev`, or a one-off script. The connection keeps
    // the driver default and the dashboard says "unnamed".
    expect(resolveApplicationName()).toEqual({ name: undefined, source: "none" });
  });

  it("treats an empty or whitespace-only declaration as absent", () => {
    process.env.OPS_APP_NAME = "   ";
    expect(applicationName()).toBeUndefined();
    expect(applicationNameSource()).toBe("none");
  });

  it("skips an empty OPS_APP_NAME rather than blocking a real PGAPPNAME", () => {
    process.env.OPS_APP_NAME = "";
    process.env.PGAPPNAME = "sandbox-web";
    expect(applicationName()).toBe("sandbox-web");
  });
});

describe("sanitising", () => {
  it("clips to 63 bytes, Postgres's NAMEDATALEN-1", () => {
    process.env.OPS_APP_NAME = "x".repeat(100);
    expect(applicationName()).toHaveLength(63);
  });

  it("strips control characters Postgres would silently replace", () => {
    // A replaced character would make the dashboard's grouping key differ from
    // what we believe we set.
    // ESC and BEL, not NUL: assigning to process.env truncates at a NUL byte,
    // so that case never reaches sanitise() in the first place.
    const ESC = String.fromCharCode(27);
    const BEL = String.fromCharCode(7);
    process.env.OPS_APP_NAME = `sandbox${ESC}-web${BEL}`;
    expect(applicationName()).toBe("sandbox-web");
  });
});

describe("applicationNameOption", () => {
  it("emits the postgres.js connection option when a name is known", () => {
    process.env.OPS_APP_NAME = "sandbox-web";
    expect(applicationNameOption()).toEqual({
      connection: { application_name: "sandbox-web" },
    });
  });

  it("emits NO key at all when the name is unknown", () => {
    // Load-bearing. postgres.js MERGES the caller's `connection` object over
    // its defaults (src/index.js:484-488), so passing
    // `{ application_name: undefined }` would overwrite the default and send an
    // empty string — reported as "(unnamed)", indistinguishable from a backend
    // that set nothing deliberately. An absent key spreads nothing and the
    // driver default survives.
    expect(applicationNameOption()).toEqual({});
    expect(Object.keys(applicationNameOption())).toHaveLength(0);
  });
});

describe("isDriverDefaultName", () => {
  it("recognises the names that mean 'nothing was declared'", () => {
    for (const name of [
      "postgres.js",
      "node-postgres",
      "PostgreSQL JDBC Driver",
      "(unnamed)",
      "",
      null,
    ]) {
      expect(isDriverDefaultName(name), String(name)).toBe(true);
    }
  });

  it("treats a real service name as an identity", () => {
    for (const name of ["sandbox-web", "sandbox-worker", "itarang-crm-web"]) {
      expect(isDriverDefaultName(name), name).toBe(false);
    }
  });
});
