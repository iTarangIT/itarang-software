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

// A customer payment from Zoho /customerpayments. A single payment can settle
// multiple invoices, listed in `invoices[]`. `reference_number` is the UTR /
// bank transaction id the dealer paid with.
export interface ZohoPaymentInvoiceLink {
  invoice_id: string;
  amount_applied?: number;
}

export interface ZohoPayment {
  payment_id: string;
  reference_number?: string;
  date?: string; // ISO date "YYYY-MM-DD"
  amount?: number;
  payment_mode?: string;
  invoices?: ZohoPaymentInvoiceLink[];
  [key: string]: unknown;
}

export interface ZohoListPaymentsResponse {
  code: number;
  message: string;
  customerpayments: ZohoPayment[];
  page_context: ZohoPageContext;
}

// An organization (legal entity) under the Zoho login — /organizations. The
// login owns one per entity (Haryana "ITG", Delhi "ITD"), and the sync pulls
// invoices from every one of them.
export interface ZohoOrganization {
  organization_id?: string;
  name?: string;
  is_org_active?: boolean;
  is_default_org?: boolean;
  [key: string]: unknown;
}

export interface ZohoListOrganizationsResponse {
  code: number;
  message: string;
  organizations?: ZohoOrganization[];
}
