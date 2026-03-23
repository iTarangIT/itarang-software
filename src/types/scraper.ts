import { InferSelectModel, InferInsertModel } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';

// ---- Drizzle-inferred types ----
export type ScraperRun = InferSelectModel<typeof schema.scraperRuns>;
export type NewScraperRun = InferInsertModel<typeof schema.scraperRuns>;

export type ScrapedDealerLead = InferSelectModel<typeof schema.scrapedDealerLeads>;
export type NewScrapedDealerLead = InferInsertModel<typeof schema.scrapedDealerLeads>;

export type ScraperDedupLog = InferSelectModel<typeof schema.scraperDedupLogs>;
export type NewScraperDedupLog = InferInsertModel<typeof schema.scraperDedupLogs>;

export type ScraperSearchQuery = InferSelectModel<typeof schema.scraperSearchQueries>;
export type NewScraperSearchQuery = InferInsertModel<typeof schema.scraperSearchQueries>;

export type ScraperSchedule = InferSelectModel<typeof schema.scraperSchedules>;
export type NewScraperSchedule = InferInsertModel<typeof schema.scraperSchedules>;
export type ScheduleFrequency = 'every_2_days' | 'weekly' | 'biweekly' | 'monthly';

// ---- Status enums ----
export type ScraperRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export type ExplorationStatus =
    | 'unassigned'
    | 'assigned'
    | 'exploring'
    | 'explored'
    | 'not_interested';

export type DedupSkipReason =
    | 'duplicate_phone'
    | 'duplicate_name_location'
    | 'duplicate_url';

// ---- API Payloads ----
export interface TriggerScraperResponse {
    run_id: string;
    message: string;
}

export interface AssignLeadPayload {
    assigned_to: string; // user UUID of the sales_manager
}

export interface UpdateStatusPayload {
    exploration_status: ExplorationStatus;
    exploration_notes?: string;
}

// ---- Rich joined types (for UI) ----
export interface ScraperRunWithStats extends ScraperRun {
    triggered_by_name?: string;
}

export interface ScrapedLeadWithAssignee extends ScrapedDealerLead {
    assigned_to_name?: string;
    assigned_by_name?: string;
}

// ---- Raw scraped data from Firecrawl ----
export interface RawDealerRecord {
    dealer_name: string;
    phone?: string;
    city?: string;
    state?: string;
    address?: string;
    source_url?: string;
    email?: string;
    gst_number?: string;
    business_type?: string;
    products_sold?: string;
    website?: string;
}
