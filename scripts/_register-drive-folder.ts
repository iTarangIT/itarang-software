/**
 * E-216 — register a Google Drive folder for the expense scanner.
 *
 * Run: node --import tsx --env-file=.env.local scripts/_register-drive-folder.ts \
 *        <folderUrlOrId> <ownerUserId> [label]
 *
 * The admin UI is the normal way to do this (it verifies reachability and sets
 * created_by from the session). This exists for seeding an environment without
 * logging in.
 *
 * Idempotent: re-running for the same folder reports the existing row rather
 * than creating a second one — drive_folder_id is UNIQUE.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { driveExpenseFolders, users } from "@/lib/db/schema";
import { describeDriveError, getFolderName, parseDriveFolderId } from "@/lib/google/drive";

async function main() {
  const [input, ownerId, labelArg] = process.argv.slice(2);
  if (!input || !ownerId) {
    console.error("usage: _register-drive-folder.ts <folderUrlOrId> <ownerUserId> [label]");
    process.exit(1);
  }

  const folderId = parseDriveFolderId(input);
  if (!folderId) {
    console.error("Could not read a Drive folder id out of:", input);
    process.exit(1);
  }

  // created_by doubles as the fallback owner for ticker-created expense rows,
  // so a bad id here would surface as a foreign-key error on every insert.
  const [owner] = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  if (!owner) {
    console.error("No such user:", ownerId);
    process.exit(1);
  }

  let name: string | null = null;
  try {
    name = await getFolderName(folderId);
  } catch (err) {
    console.error("Cannot reach that folder:", describeDriveError(err));
    process.exit(2);
  }

  const [existing] = await db
    .select()
    .from(driveExpenseFolders)
    .where(eq(driveExpenseFolders.drive_folder_id, folderId))
    .limit(1);

  if (existing) {
    console.log("Already registered:");
    console.table([existing]);
    process.exit(0);
  }

  const [row] = await db
    .insert(driveExpenseFolders)
    .values({
      drive_folder_id: folderId,
      label: labelArg || name || folderId,
      created_by: owner.id,
      // include_names / exclude_names / recursive / is_active take their column
      // defaults ('purchase' / 'sale' / true / true).
    })
    .returning();

  console.log(`Registered "${row.label}"`);
  console.log(`  drive_folder_id : ${row.drive_folder_id}`);
  console.log(`  owner           : ${owner.email} (${owner.role})`);
  console.log(`  include_names   : ${row.include_names}   <- only these branches import`);
  console.log(`  exclude_names   : ${row.exclude_names}`);
  console.log(`  recursive       : ${row.recursive}`);
  console.log(`  is_active       : ${row.is_active}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
