/**
 * E-216 — does the service account actually reach a Drive folder?
 *
 * Run: node --import tsx --env-file=.env.local scripts/_check-drive-access.ts <folderId>
 *
 * Three outcomes worth telling apart:
 *   accessNotConfigured  → Drive API not enabled in the service account's GCP project
 *   404 / 403            → folder not shared with the service account
 *   returns []           → reachable, but empty
 *
 * That last one is the dangerous case in normal operation: an unshared folder
 * lists as empty rather than erroring, which reads exactly like "no new
 * invoices". Hence checking getFolderName first — that DOES 404.
 */
import {
  describeDriveError,
  getFolderName,
  isDriveConfigured,
  listFolderFiles,
} from "@/lib/google/drive";

const FOLDER_ID = process.argv[2];

async function main() {
  if (!FOLDER_ID) {
    console.error("usage: _check-drive-access.ts <folderId>");
    process.exit(1);
  }

  console.log("configured      :", isDriveConfigured());
  console.log("service account :", process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
  console.log("folder id       :", FOLDER_ID);
  console.log("---");

  try {
    console.log("folder name     :", await getFolderName(FOLDER_ID));
  } catch (err) {
    console.log("\nCANNOT REACH FOLDER");
    console.log("diagnosis :", describeDriveError(err));
    console.log("raw       :", err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const { files, skippedFolders, skippedOutOfScope, truncatedAtDepth } =
    await listFolderFiles(FOLDER_ID, { recursive: true });

  if (skippedFolders.length > 0) {
    const uniq = [...new Set(skippedFolders)];
    console.log(`\nexcluded ${uniq.length} folder(s) by name:`);
    for (const p of uniq) console.log(`    ${p}`);
    console.log("  (these hold customer invoices — revenue, not expenses)");
  }

  if (skippedOutOfScope.length > 0) {
    const uniq = [...new Set(skippedOutOfScope)];
    console.log(
      `\n${skippedOutOfScope.length} file(s) outside the allowlist, in ${uniq.length} folder(s):`,
    );
    for (const p of uniq.slice(0, 25)) console.log(`    ${p}`);
    if (uniq.length > 25) console.log(`    … +${uniq.length - 25} more`);
    console.log("  (check for a purchase folder the allowlist does not recognise)");
  }
  if (truncatedAtDepth) {
    console.log("\nWARNING: tree is deeper than the walk limit — some files were missed.");
  }

  console.log(`\n${files.length} file(s) found\n`);

  const byType = new Map<string, number>();
  let oversize = 0;
  for (const f of files) {
    byType.set(f.mimeType, (byType.get(f.mimeType) ?? 0) + 1);
    if (f.size != null && f.size > 10 * 1024 * 1024) oversize += 1;
  }

  // Grouped by folder, because in an accounts tree the path is the meaning:
  // it says which month, which entity, and whether this side is purchases.
  // A flat list of 258 filenames tells you nothing you can act on.
  const byFolder = new Map<string, typeof files>();
  for (const f of files) {
    const key = f.folderPath || "(root)";
    if (!byFolder.has(key)) byFolder.set(key, []);
    byFolder.get(key)!.push(f);
  }

  console.log("--- files by folder ---");
  for (const [folderPath, group] of [...byFolder].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    console.log(`\n  ${folderPath}   [${group.length}]`);
    for (const f of group.slice(0, 6)) console.log(`      ${f.name}`);
    if (group.length > 6) console.log(`      … and ${group.length - 6} more`);
  }
  console.log("");

  console.log("\n--- by mime type ---");
  for (const [mime, n] of [...byType].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${mime}`);
  }
  console.log(`\noversize (>10MB, would be skipped): ${oversize}`);
  console.log(`estimated first-scan model calls  : ${files.length}`);
}

main().catch((e) => {
  console.error("FAILED:", describeDriveError(e));
  console.error(e);
  process.exit(1);
});
