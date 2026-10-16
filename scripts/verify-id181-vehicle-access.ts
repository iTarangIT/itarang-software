/**
 * Read-only check of the ID 181 vehicle rule against real rows: for a few
 * dealer logins, the vehicles mapped to them, and whether each may open its
 * own vehicle and another dealer's.
 *
 *   node --import tsx --env-file=.env.local scripts/verify-id181-vehicle-access.ts
 *
 * Imports the real lookups (resolveDealerCode, dealerVehicleNumbers) and the
 * real rule (mayOpenVehicle) — nothing is restated. Writes nothing; never
 * touches the IoT VPS.
 */
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { resolveDealerCode } from "@/lib/auth/requireLeadAccess";
import { dealerVehicleNumbers } from "@/lib/telemetry/queries";
import { mayOpenVehicle } from "@/lib/telemetry/vehicleAccessRules";

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] })?.rows ?? [])) as T[];

let failures = 0;
function check(label: string, got: boolean, want: boolean) {
    const ok = got === want;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${got ? "opens" : "refused"}`);
}

async function main() {
    const host = (process.env.DATABASE_URL ?? "").replace(/^.*@/, "").replace(/[:/].*$/, "");
    console.log(`database host: ${host}\n`);

    const [table] = rowsOf<{ t: string | null }>(
        await db.execute(sql`SELECT to_regclass('public.telemetry_location_access_log')::text AS t`),
    );
    console.log(`E-347 telemetry_location_access_log: ${table?.t ? "present" : "MISSING (opens are not logged)"}\n`);

    const mapped = rowsOf<{ dealer_id: string; vehicle_number: string }>(
        await db.execute(sql`
            SELECT dealer_id, vehicle_number FROM device_battery_map
             WHERE status = 'active' AND vehicle_number IS NOT NULL AND coalesce(dealer_id, '') <> ''
             ORDER BY dealer_id, vehicle_number
        `),
    );
    console.log(`active mapped vehicles: ${mapped.length}`);

    const dealers = rowsOf<{ id: string; role: string; dealer_id: string | null }>(
        await db.execute(sql`SELECT id::text, role, dealer_id FROM users WHERE role = 'dealer' AND is_active ORDER BY created_at LIMIT 25`),
    );
    let noCode = 0;
    for (const u of dealers) {
        const code = await resolveDealerCode(u);
        if (!code) {
            noCode++;
            check(`dealer ${u.id.slice(0, 8)} (no dealer code) on any vehicle`, mayOpenVehicle({ role: "dealer", vehicleNumber: mapped[0]?.vehicle_number ?? "X", mappedVehicleNumbers: [] }), false);
            continue;
        }
        const own = await dealerVehicleNumbers(code);
        const foreign = mapped.find((m) => m.dealer_id !== code && !own.includes(m.vehicle_number));
        if (own[0]) {
            check(`dealer ${code} on own ${own[0]}`, mayOpenVehicle({ role: "dealer", vehicleNumber: own[0], mappedVehicleNumbers: own }), true);
        }
        if (foreign) {
            check(`dealer ${code} on ${foreign.dealer_id}'s ${foreign.vehicle_number}`, mayOpenVehicle({ role: "dealer", vehicleNumber: foreign.vehicle_number, mappedVehicleNumbers: own }), false);
        }
    }
    console.log(`\ndealer logins checked: ${dealers.length} (without a dealer code: ${noCode})`);
    console.log(failures ? `\n${failures} FAIL` : "\nall PASS");
    process.exit(failures ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
