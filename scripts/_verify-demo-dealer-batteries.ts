import { config } from "dotenv";
config({ path: ".env.local" });
import { listDealerBatteries } from "../src/lib/inventory/dealer-stock";

async function main() {
  const dealerId = process.argv.includes("--dealer")
    ? process.argv[process.argv.indexOf("--dealer") + 1]
    : "ACC-ITARANG-20260615-feed05";

  const all = await listDealerBatteries({ dealerId });
  console.log(`listDealerBatteries(no category) -> ${all.length} rows`);
  console.table(
    all.map((b) => ({
      serial: b.serial_number,
      model: b.model_type,
      name: b.model_name,
      net: b.net_amount,
      age: b.inventory_age_days,
      badge: b.age_badge,
      rec: b.recommended,
    })),
  );

  for (const cat of ["3W", "1fa3fb60-b7f9-416e-84c9-0ec1b74c5f84"]) {
    const r = await listDealerBatteries({ dealerId, category: cat });
    console.log(`listDealerBatteries(category=${cat}) -> ${r.length} rows`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
