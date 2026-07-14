import { db } from "@/lib/db";
import { deviceBatteryMap } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
async function main() {
  const [c] = await db.select({
    total: sql<number>`count(*)::int`,
    withName: sql<number>`count(customer_name)::int`,
    withVeh: sql<number>`count(vehicle_number)::int`,
  }).from(deviceBatteryMap);
  console.log("device_battery_map:", c);
  const sample = await db.select({
    vehicle_number: deviceBatteryMap.vehicle_number,
    device_id: deviceBatteryMap.device_id,
    customer_name: deviceBatteryMap.customer_name,
  }).from(deviceBatteryMap).limit(5);
  console.log("\nsample rows:");
  for (const r of sample) console.log(" ", JSON.stringify(r));
}
main().catch(e => console.error("FAILED:", e.message));
