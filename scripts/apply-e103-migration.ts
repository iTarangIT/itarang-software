import "dotenv/config";
import * as dotenv from "dotenv";
import postgres from "postgres";

dotenv.config({ path: ".env.local" });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Make sure .env.local exists with the AWS RDS connection string.");
  process.exit(1);
}

const sql = postgres(url, {
  ssl: { rejectUnauthorized: false },
  max: 1,
});

async function main() {
  console.log("E-103: Renaming product_selections.sub_category -> model_number and widening to varchar(100)...");

  const cols = await sql<{ column_name: string; character_maximum_length: number | null }[]>`
    SELECT column_name, character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'product_selections'
      AND column_name IN ('sub_category', 'model_number')
  `;

  const hasModelNumber = cols.some((c) => c.column_name === "model_number");
  const hasSubCategory = cols.some((c) => c.column_name === "sub_category");

  if (!hasModelNumber && !hasSubCategory) {
    console.log("  Neither sub_category nor model_number exists on product_selections — nothing to do.");
    await sql.end();
    return;
  }

  if (hasModelNumber && hasSubCategory) {
    console.log("  Both columns exist. Refusing to clobber — please reconcile manually.");
    await sql.end();
    process.exit(1);
  }

  if (hasSubCategory && !hasModelNumber) {
    console.log("  Found sub_category; renaming to model_number.");
    await sql.unsafe(`ALTER TABLE product_selections RENAME COLUMN sub_category TO model_number`);
  } else {
    console.log("  model_number already exists; rename step skipped.");
  }

  const [{ character_maximum_length: len } = { character_maximum_length: null }] = await sql<
    { character_maximum_length: number | null }[]
  >`
    SELECT character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'product_selections'
      AND column_name = 'model_number'
  `;

  if (len === 100) {
    console.log("  model_number is already varchar(100); skipping widen.");
  } else {
    console.log(`  Widening model_number from varchar(${len ?? "unknown"}) to varchar(100).`);
    await sql.unsafe(`ALTER TABLE product_selections ALTER COLUMN model_number TYPE varchar(100)`);
  }

  const after = await sql<{ column_name: string; data_type: string; character_maximum_length: number | null }[]>`
    SELECT column_name, data_type, character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'product_selections'
      AND column_name = 'model_number'
  `;
  console.log("  Final state:", after[0]);

  await sql.end();
  console.log("Done.");
}

main().catch((err) => {
  console.error("E-103 migration failed:", err);
  process.exit(1);
});
