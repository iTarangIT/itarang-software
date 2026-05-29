import type { APIRequestContext, Download, Page } from '@playwright/test';

export interface InvoiceRow {
  id: string;
  zoho_invoice_id: string;
  invoice_number: string | null;
  customer_name: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency_code: string | null;
  total: string | null;
  balance: string | null;
  status: string | null;
}

export interface InvoicesJson {
  success: boolean;
  data: InvoiceRow[];
  summary: { count: number; total: number; balance: number };
  filters: Record<string, unknown>;
}

export interface InvoiceFilter {
  from?: string;
  to?: string;
  status?: string;
  customer?: string;
  limit?: number;
  offset?: number;
}

function buildQS(f: InvoiceFilter): string {
  const p = new URLSearchParams();
  if (f.from) p.set('from', f.from);
  if (f.to) p.set('to', f.to);
  if (f.status) p.set('status', f.status);
  if (f.customer) p.set('customer', f.customer);
  if (f.limit !== undefined) p.set('limit', String(f.limit));
  if (f.offset !== undefined) p.set('offset', String(f.offset));
  return p.toString();
}

export async function fetchInvoicesJson(
  request: APIRequestContext,
  filter: InvoiceFilter = {},
): Promise<InvoicesJson> {
  const r = await request.get(`/api/admin/zoho/invoices?${buildQS(filter)}`);
  if (!r.ok()) {
    throw new Error(`Invoice JSON fetch failed: ${r.status()} ${await r.text()}`);
  }
  return (await r.json()) as InvoicesJson;
}

/**
 * Click the "Export CSV" button on /ceo/invoices and capture the download.
 * Returns the CSV body + the suggested filename + the content-type the route
 * served when fetched directly (downloads don't expose headers — we re-fetch).
 */
export async function downloadCsv(
  page: Page,
  request: APIRequestContext,
  filter: InvoiceFilter,
): Promise<{ filename: string; text: string; contentType: string }> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    page.getByTestId('export-csv').click(),
  ]);
  const filename = download.suggestedFilename();
  const path = await download.path();
  if (!path) throw new Error('Playwright did not persist the CSV download');
  const fs = await import('node:fs/promises');
  const text = await fs.readFile(path, 'utf8');

  // Independent fetch to verify the response headers (downloads strip them).
  const headResp = await request.get(
    `/api/admin/zoho/invoices?${buildQS({ ...filter, })}&format=csv`,
  );
  const contentType = headResp.headers()['content-type'] ?? '';

  return { filename, text, contentType };
}

/**
 * Tiny RFC4180-ish CSV parser. Sufficient for our column set (no embedded
 * newlines in current Zoho data; commas inside customer names ARE quoted by
 * the route's csvEscape).
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let cell = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') {
        row.push(cell);
        cell = '';
      } else if (c === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else if (c === '\r') {
        // ignore
      } else {
        cell += c;
      }
    }
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].length > 0));
}

/**
 * Sum the `Total` column from a parsed CSV. Assumes the header row is index 0
 * and matches the route's exact column order.
 */
export function sumTotalsFromCsv(text: string): { rowCount: number; total: number } {
  const rows = parseCsv(text);
  if (rows.length < 1) return { rowCount: 0, total: 0 };
  const header = rows[0];
  const totalIdx = header.indexOf('Total');
  if (totalIdx < 0) {
    throw new Error(`CSV header missing "Total" column. Header: ${header.join('|')}`);
  }
  const data = rows.slice(1);
  let total = 0;
  for (const r of data) {
    total += Number(r[totalIdx] ?? 0);
  }
  return { rowCount: data.length, total };
}
