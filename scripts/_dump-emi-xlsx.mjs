import xlsx from "xlsx";
const wb = xlsx.readFile("C:/Users/Aniket/Downloads/EMI Collect Data.xlsx");
console.log("Sheets:", wb.SheetNames);
for (const name of wb.SheetNames) {
  const ws = wb.Sheets[name];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: null });
  console.log(`\n===== Sheet: ${name} (${rows.length} rows) =====`);
  if (rows.length) {
    console.log("Columns:", JSON.stringify(Object.keys(rows[0])));
    console.log("First 3 rows:");
    console.log(JSON.stringify(rows.slice(0, 3), null, 2));
  }
}
