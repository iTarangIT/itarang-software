/**
 * Curated map of the CRM's navigable surface — every role's dashboard plus its
 * key sub-pages. Only STATIC routes (no [id]/[leadId] params) are listed so the
 * smoke sweep is deterministic and needs no seeded row to load a page.
 *
 * The CEO session can reach all of these (middleware bypasses the role-mismatch
 * redirect for ceo), so the smoke spec drives the whole list from one session.
 * Role-native pages that only make sense for a specific persona are covered by
 * the per-role sections in workflow-smoke.spec.ts.
 */

export type Route = { module: string; path: string };

export const ROUTES: Route[] = [
  // CEO
  { module: 'CEO', path: '/ceo' },
  { module: 'CEO', path: '/ceo/expenses' },
  { module: 'CEO', path: '/ceo/ai-dialer' },
  { module: 'CEO', path: '/ceo/intellicar' },

  // Business Head
  { module: 'Business Head', path: '/business-head' },
  { module: 'Business Head', path: '/business-head/approvals' },
  { module: 'Business Head', path: '/business-head/credits' },

  // Sales Head
  { module: 'Sales Head', path: '/sales-head' },

  // Sales Manager
  { module: 'Sales Manager', path: '/sales-manager' },
  { module: 'Sales Manager', path: '/sales-manager/scraper-leads' },
  { module: 'Sales Manager', path: '/sales-manager/ai-calls' },

  // Sales Executive
  { module: 'Sales Executive', path: '/sales-executive' },

  // ASM
  { module: 'ASM', path: '/asm' },

  // Finance Controller
  { module: 'Finance', path: '/finance-controller' },
  { module: 'Finance', path: '/finance-controller/invoices' },
  { module: 'Finance', path: '/finance-controller/payments' },
  { module: 'Finance', path: '/finance-controller/credits' },

  // Inventory
  { module: 'Inventory', path: '/inventory-manager' },
  { module: 'Inventory', path: '/inventory' },
  { module: 'Inventory', path: '/admin/inventory' },
  { module: 'Inventory', path: '/admin/inventory/add' },
  { module: 'Inventory', path: '/admin/inventory/ageing-report' },
  { module: 'Inventory', path: '/admin/inventory/transfer' },
  { module: 'Inventory', path: '/admin/inventory/upload' },

  // Service Engineer
  { module: 'Service Engineer', path: '/service-engineer' },
  { module: 'Service Engineer', path: '/service-engineer/pdi-queue' },

  // Sales Order Manager
  { module: 'Sales Order Manager', path: '/sales-order-manager' },
  { module: 'Sales Order Manager', path: '/sales-order-manager/orders' },
  { module: 'Sales Order Manager', path: '/sales-order-manager/oem-onboarding' },
  { module: 'Sales Order Manager', path: '/sales-order-manager/pi-invoices' },
  { module: 'Sales Order Manager', path: '/sales-order-manager/provisions' },

  // Procurement / HR
  { module: 'Procurement', path: '/procurement' },
  { module: 'HR', path: '/hr' },

  // Shared operational surfaces
  { module: 'Leads', path: '/leads' },
  { module: 'Leads', path: '/leads/new' },
  { module: 'Deals', path: '/deals' },
  { module: 'Orders', path: '/orders' },
  { module: 'Approvals', path: '/approvals' },
  { module: 'Disputes', path: '/disputes' },
  { module: 'Provisions', path: '/provisions' },
  { module: 'Product Catalog', path: '/product-catalog' },
  { module: 'Profile', path: '/profile' },

  // Admin
  { module: 'Admin', path: '/admin' },
  { module: 'Admin', path: '/admin/kyc-review' },
  { module: 'Admin', path: '/admin/leads-info' },
  { module: 'Admin', path: '/admin/escalations' },
  { module: 'Admin', path: '/admin/onboarding-dropouts' },
  { module: 'Admin', path: '/admin/merge-requests' },
  { module: 'Admin', path: '/admin/product-master' },
  { module: 'Admin', path: '/admin/product-review' },
  { module: 'Admin', path: '/admin/loan-products' },
  { module: 'Admin', path: '/admin/coupon-management' },
  { module: 'Admin', path: '/admin/reports' },
  { module: 'Admin', path: '/admin/settings' },

  // NBFC (admin-facing directory + governance)
  { module: 'NBFC Portal', path: '/admin/nbfc' },
  { module: 'NBFC Portal', path: '/admin/nbfc/approvals' },
  { module: 'NBFC Portal', path: '/admin/nbfc/audit-log' },
  { module: 'NBFC Portal', path: '/admin/nbfc/ecosystem-overview' },
  { module: 'NBFC Portal', path: '/admin/nbfc/risk-rules' },
];

/**
 * Dealer-portal routes — driven by the dealer session (a dealer sees a scoped
 * view the CEO cannot fully reproduce).
 */
export const DEALER_ROUTES: Route[] = [
  { module: 'Dealer Portal', path: '/dealer-portal' },
  { module: 'Dealer Portal', path: '/dealer-portal/leads' },
  { module: 'Dealer Portal', path: '/dealer-portal/leads/drafts' },
  { module: 'Dealer Portal', path: '/dealer-portal/batteries' },
  { module: 'Dealer Portal', path: '/dealer-portal/assets' },
  { module: 'Dealer Portal', path: '/dealer-portal/loans' },
  { module: 'Dealer Portal', path: '/dealer-portal/loans/facilitation' },
  { module: 'Dealer Portal', path: '/dealer-portal/onboarding-status' },
];
