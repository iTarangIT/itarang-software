/**
 * Tracker ID 181 (18 Oct follow-up) — source-text contract: dealer trips are
 * capped at 7 days, the NBFC battery-monitoring history feed uses the fleet's
 * dealer mapping with the 7-day GPS cap and the open log, and the fleet map
 * writes the open log. The routes import the database, so this reads source.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (...parts: string[]) =>
  readFileSync(join(ROOT, ...parts), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const route = (r: string) => read("src", "app", "api", ...r.split("/"), "route.ts");

describe("ID 181 — trips", () => {
  it("the trips route passes the dealer 7-day window to the query", () => {
    const src = route("telemetry/devices/[deviceId]/trips");
    expect(src).toMatch(/hours: \(v\) => tripWindowHours\(v\.role\)/);
    expect(src).toMatch(/fetchDeviceTrips\(deviceId, limit, gate\.hours\)/);
  });

  it("fetchDeviceTrips filters by start time when a window is given", () => {
    const src = read("src", "lib", "telemetry", "queries.ts");
    expect(src).toMatch(/fetchDeviceTrips\(deviceId: string, limit = 20, sinceHours: number \| null = null\)/);
    expect(src).toMatch(/AND time > now\(\) - \(interval '1 hour' \* \$\{sinceHours\}\)/);
  });
});

describe("ID 181 — NBFC battery monitoring history", () => {
  const src = route("nbfc/iot/battery/[serialNumber]/history");

  it("trims a dealer's GPS range and logs every dealer open", () => {
    expect(src).toMatch(/capDealerRange\(/);
    expect(src).toMatch(/role: metric === "gps" \? actor\.role/);
    expect(src).toMatch(/logVehicleOpen\(/);
    expect(src).toMatch(/allowed: auth === "ok"/);
    expect(src).toMatch(/fromDate = range\.from/);
  });

  it("dealer scope uses the fleet's device_battery_map mapping, not iot_devices.dealer_id", () => {
    const scope = read("src", "lib", "nbfc", "battery-scope.ts");
    expect(scope).toMatch(/dealerVehicleNumbers\(actor\.dealer_id\)/);
    expect(scope).not.toMatch(/device\.dealer_id === actor\.dealer_id/);
    expect(scope).toMatch(/resolveDealerCode\(/);
  });
});

describe("ID 181 — fleet map", () => {
  it("writes the vehicle open log on every load", () => {
    const src = route("telemetry/fleet/map");
    expect(src).toMatch(/logVehicleOpens\(/);
    expect(src).toMatch(/feed: 'fleet_map'/);
    expect(src).toMatch(/fleetMapLogEntries\(/);
  });
});
