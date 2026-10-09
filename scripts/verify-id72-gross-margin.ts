// SUPERSEDED (ID 147, 2026-10-09).
//
// This used to check gross margin against its own line store
// (sales_invoice_lines + sales_invoice_item_products, E-326). Gross margin no
// longer reads that store: it reads invoice_line_items with the Invoice Ledger
// item mapping, exactly as By SKU does. The check that matters now is
//
//   node --import tsx --env-file=.env.local scripts/verify-id147-sku-vs-margin.ts [from] [to]
//
// which proves gross margin and By SKU agree month by month.

console.log("Superseded — run scripts/verify-id147-sku-vs-margin.ts (gross margin now reads the invoice ledger, ID 147).");
process.exit(0);
