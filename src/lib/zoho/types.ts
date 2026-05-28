// Minimal subset of the Zoho Invoice API response we persist.
// Full payload is stored as JSONB in zoho_invoices.raw_json — only fields
// we read for aggregation or UI display are typed here.

export interface ZohoInvoice {
  invoice_id: string;
  invoice_number?: string;
  customer_id?: string;
  customer_name?: string;
  date?: string;            // ISO date "YYYY-MM-DD"
  due_date?: string;
  currency_code?: string;
  total?: number;
  balance?: number;
  status?: string;          // draft | sent | overdue | paid | partially_paid | void
  last_modified_time?: string; // ISO timestamp
  [key: string]: unknown;
}

export interface ZohoPageContext {
  page: number;
  per_page: number;
  has_more_page: boolean;
  sort_column?: string;
  sort_order?: string;
}

export interface ZohoListInvoicesResponse {
  code: number;
  message: string;
  invoices: ZohoInvoice[];
  page_context: ZohoPageContext;
}
