import { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';

// Foundation
export type User = InferSelectModel<typeof schema.users>;
export type NewUser = InferInsertModel<typeof schema.users>;

// Product Catalog
export type ProductCategory = InferSelectModel<typeof schema.productCategories>;
export type NewProductCategory = InferInsertModel<typeof schema.productCategories>;
export type Product = InferSelectModel<typeof schema.products>;
export type NewProduct = InferInsertModel<typeof schema.products>;

export type OEM = InferSelectModel<typeof schema.oems>;
export type NewOEM = InferInsertModel<typeof schema.oems>;

export type OEMContact = InferSelectModel<typeof schema.oemContacts>;
export type NewOEMContact = InferInsertModel<typeof schema.oemContacts>;

export type Inventory = InferSelectModel<typeof schema.inventory>;
export type NewInventory = InferInsertModel<typeof schema.inventory>;

// Dealer Sales
export type Lead = InferSelectModel<typeof schema.leads>;
export type NewLead = InferInsertModel<typeof schema.leads>;

export type LeadAssignment = InferSelectModel<typeof schema.leadAssignments>;
export type Deal = InferSelectModel<typeof schema.deals>;
export type NewDeal = InferInsertModel<typeof schema.deals>;

export type Approval = InferSelectModel<typeof schema.approvals>;
export type OrderDispute = InferSelectModel<typeof schema.orderDisputes>;
export type SLA = InferSelectModel<typeof schema.slas>;

// PDI
export type PDIRecord = InferSelectModel<typeof schema.pdiRecords>;
export type NewPDIRecord = InferInsertModel<typeof schema.pdiRecords>;

// Procurement
export type Provision = InferSelectModel<typeof schema.provisions>;
export type Order = InferSelectModel<typeof schema.orders>;
export type Account = InferSelectModel<typeof schema.accounts>;

// AI Dialer
export type AiCallLog = InferSelectModel<typeof schema.aiCallLogs>;
export type NewAiCallLog = InferInsertModel<typeof schema.aiCallLogs>;

// Telemetry
export type DeviceBatteryMap = InferSelectModel<typeof schema.deviceBatteryMap>;
export type BatteryAlert = InferSelectModel<typeof schema.batteryAlerts>;

// Settings
export type AppSetting = InferSelectModel<typeof schema.appSettings>;

// Dealer Lead Scraper
export type ScraperRun = InferSelectModel<typeof schema.scraperRuns>;
export type NewScraperRun = InferInsertModel<typeof schema.scraperRuns>;
export type ScrapedDealerLead = InferSelectModel<typeof schema.scrapedDealerLeads>;
export type NewScrapedDealerLead = InferInsertModel<typeof schema.scrapedDealerLeads>;
export type ScraperDedupLog = InferSelectModel<typeof schema.scraperDedupLogs>;
