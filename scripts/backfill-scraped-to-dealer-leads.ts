import "dotenv/config";
import * as dotenv from "dotenv";
import postgres from "postgres";
import { nanoid } from "nanoid";

dotenv.config({ path: ".env.local" });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, {
  ssl: { rejectUnauthorized: false },
  max: 1,
});

function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  const trimmed = digits.length > 10 ? digits.slice(-10) : digits;
  if (trimmed.length !== 10) return null;
  if (!/^[6-9]/.test(trimmed)) return null;
  return trimmed;
}

async function main() {
  console.log("Reading scraped_dealer_leads...");

  const rows = await sql<
    {
      dealer_name: string | null;
      phone: string | null;
      location_city: string | null;
    }[]
  >`
    SELECT dealer_name, phone, location_city
    FROM scraped_dealer_leads
    WHERE phone IS NOT NULL AND phone <> ''
  `;

  console.log(`Found ${rows.length} scraped leads with phones.`);

  const seen = new Set<string>();
  const candidates: {
    id: string;
    dealer_name: string | null;
    shop_name: string | null;
    phone: string;
    location: string | null;
  }[] = [];

  for (const row of rows) {
    const phone = normalizePhone(row.phone);
    if (!phone) continue;
    if (seen.has(phone)) continue;
    seen.add(phone);

    candidates.push({
      id: `L-${nanoid(8)}`,
      dealer_name: row.dealer_name?.trim() || null,
      shop_name: row.dealer_name?.trim() || null,
      phone,
      location: row.location_city?.trim() || null,
    });
  }

  console.log(`${candidates.length} unique valid phones after normalization.`);

  if (!candidates.length) {
    await sql.end();
    console.log("Nothing to promote.");
    return;
  }

  let inserted = 0;

  for (const row of candidates) {
    const result = await sql<{ id: string }[]>`
      INSERT INTO dealer_leads
        (id, dealer_name, shop_name, phone, location, language,
         current_status, total_attempts, follow_up_history, created_at)
      VALUES
        (${row.id}, ${row.dealer_name}, ${row.shop_name}, ${row.phone},
         ${row.location}, 'hindi', 'new', 0, '[]'::jsonb, NOW())
      ON CONFLICT (phone) DO NOTHING
      RETURNING id
    `;
    if (result.length) inserted += 1;
  }

  console.log(`Done. ${inserted} leads promoted to dealer_leads.`);
  console.log(
    `(${candidates.length - inserted} skipped as duplicates already in dealer_leads.)`,
  );

  await sql.end();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
