# Dealer Lead Scraper Improvements — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the existing Firecrawl-based dealer lead scraper with configurable queries, smart deep crawling, lead conversion to CRM, data enrichment, scheduled runs, and richer field extraction.

**Architecture:** Six incremental features built on top of the existing scraper. Each feature is additive — no rewriting of working code. New DB tables for queries and schedules; new columns on existing `scraped_dealer_leads` table for enrichment and extra fields.

**Tech Stack:** Next.js 16.1.3, React 19, Drizzle ORM, PostgreSQL (Supabase), Firecrawl v4, Tailwind CSS 4, TanStack Query, Zod, Vercel Cron.

**Spec:** `docs/superpowers/specs/2026-03-10-scraper-improvements-design.md`

---

## Chunk 1: Configurable Search Queries

### Task 1: DB Schema — `scraper_search_queries` table

**Files:**
- Modify: `src/lib/db/schema.ts` (after line 1416, before relations)
- Create: `drizzle/migrations/0011_scraper_queries_and_schedules.sql`

- [ ] **Step 1: Add Drizzle schema for `scraper_search_queries`**

In `src/lib/db/schema.ts`, after the `scraperDedupLogs` table (line 1416), add:

```typescript
export const scraperSearchQueries = pgTable('scraper_search_queries', {
    id: varchar('id', { length: 255 }).primaryKey(),             // SQ-YYYYMMDD-SEQ
    query_text: text('query_text').notNull(),
    is_active: boolean('is_active').notNull().default(true),
    created_by: uuid('created_by').references(() => users.id).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
    sqActiveIdx: index('sq_active_idx').on(table.is_active),
}));

export const scraperSearchQueriesRelations = relations(scraperSearchQueries, ({ one }) => ({
    createdBy: one(users, { fields: [scraperSearchQueries.created_by], references: [users.id] }),
}));
```

- [ ] **Step 2: Add type exports**

In `src/types/scraper.ts`, add:

```typescript
export type ScraperSearchQuery = InferSelectModel<typeof schema.scraperSearchQueries>;
export type NewScraperSearchQuery = InferInsertModel<typeof schema.scraperSearchQueries>;
```

- [ ] **Step 3: Generate and run migration**

```bash
npx drizzle-kit generate
```

Review the generated SQL. It should create the `scraper_search_queries` table. Then apply:

```bash
npx drizzle-kit push
```

- [ ] **Step 4: Seed existing hardcoded queries**

Create a seed in the migration SQL that inserts the 5 existing queries from `DEALER_SEARCH_QUERIES` in `src/lib/firecrawl.ts`:

```sql
INSERT INTO scraper_search_queries (id, query_text, is_active, created_by, created_at, updated_at)
SELECT
    'SQ-SEED-' || row_number() OVER (),
    q.text,
    true,
    (SELECT id FROM users WHERE role = 'sales_head' LIMIT 1),
    NOW(),
    NOW()
FROM (VALUES
    ('3 wheeler electric battery dealer wholesale India'),
    ('e-rickshaw battery distributor dealer India'),
    ('electric rickshaw battery supplier dealer list India'),
    ('3W EV battery dealer contact phone number India'),
    ('lithium battery 3 wheeler dealer India directory')
) AS q(text);
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/schema.ts src/types/scraper.ts drizzle/
git commit -m "feat(scraper): add scraper_search_queries table schema and migration"
```

---

### Task 2: CRUD API for Search Queries

**Files:**
- Create: `src/app/api/scraper/queries/route.ts`
- Create: `src/app/api/scraper/queries/[id]/route.ts`

- [ ] **Step 1: Create GET + POST route**

Create `src/app/api/scraper/queries/route.ts`:

```typescript
import { db } from '@/lib/db';
import { scraperSearchQueries, users } from '@/lib/db/schema';
import { generateId, withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

const createSchema = z.object({
    query_text: z.string().min(3).max(500),
});

export const GET = withErrorHandler(async () => {
    await requireRole(['sales_head', 'ceo', 'business_head']);

    const rows = await db
        .select({
            id: scraperSearchQueries.id,
            query_text: scraperSearchQueries.query_text,
            is_active: scraperSearchQueries.is_active,
            created_by_name: users.name,
            created_at: scraperSearchQueries.created_at,
        })
        .from(scraperSearchQueries)
        .leftJoin(users, eq(scraperSearchQueries.created_by, users.id))
        .orderBy(desc(scraperSearchQueries.created_at));

    return successResponse(rows);
});

export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['sales_head', 'ceo', 'business_head']);

    const body = await req.json();
    const result = createSchema.safeParse(body);
    if (!result.success) return errorResponse(result.error.issues[0].message, 400);

    const id = await generateId('SQ', scraperSearchQueries);
    await db.insert(scraperSearchQueries).values({
        id,
        query_text: result.data.query_text.trim(),
        created_by: user.id,
    });

    return successResponse({ id, message: 'Query added' }, 201);
});
```

- [ ] **Step 2: Create PATCH + DELETE route**

Create `src/app/api/scraper/queries/[id]/route.ts`:

```typescript
import { db } from '@/lib/db';
import { scraperSearchQueries } from '@/lib/db/schema';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const updateSchema = z.object({
    query_text: z.string().min(3).max(500).optional(),
    is_active: z.boolean().optional(),
});

export const PATCH = withErrorHandler(
    async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
        await requireRole(['sales_head', 'ceo', 'business_head']);
        const { id } = await params;

        const body = await req.json();
        const result = updateSchema.safeParse(body);
        if (!result.success) return errorResponse(result.error.issues[0].message, 400);

        const updates: Record<string, unknown> = { updated_at: new Date() };
        if (result.data.query_text !== undefined) updates.query_text = result.data.query_text.trim();
        if (result.data.is_active !== undefined) updates.is_active = result.data.is_active;

        const [updated] = await db
            .update(scraperSearchQueries)
            .set(updates)
            .where(eq(scraperSearchQueries.id, id))
            .returning({ id: scraperSearchQueries.id });

        if (!updated) return errorResponse('Query not found', 404);
        return successResponse({ message: 'Query updated' });
    }
);

export const DELETE = withErrorHandler(
    async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
        await requireRole(['sales_head', 'ceo', 'business_head']);
        const { id } = await params;

        const [deleted] = await db
            .delete(scraperSearchQueries)
            .where(eq(scraperSearchQueries.id, id))
            .returning({ id: scraperSearchQueries.id });

        if (!deleted) return errorResponse('Query not found', 404);
        return successResponse({ message: 'Query deleted' });
    }
);
```

- [ ] **Step 3: Verify build**

```bash
npx next build
```

Expected: Build succeeds with no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/scraper/queries/
git commit -m "feat(scraper): add CRUD API for search queries"
```

---

### Task 3: Update Scraper Engine to Use DB Queries

**Files:**
- Modify: `src/lib/firecrawl.ts` (lines 134-158, `scrapeAllDealers` function)

- [ ] **Step 1: Modify `scrapeAllDealers` to accept queries parameter**

Replace the `scrapeAllDealers` function in `src/lib/firecrawl.ts`:

```typescript
export async function scrapeAllDealers(customQueries?: string[]): Promise<{
    records: RawDealerRecord[];
    queriesUsed: string[];
}> {
    const queries = customQueries ?? DEALER_SEARCH_QUERIES;
    const allRecords: RawDealerRecord[] = [];
    const seenPhones = new Set<string>();
    const seenUrls = new Set<string>();

    for (const query of queries) {
        const batch = await searchDealers(query);
        for (const record of batch) {
            const phoneKey = record.phone;
            const urlKey = record.source_url ? record.source_url.split('?')[0] : null;

            if (phoneKey && seenPhones.has(phoneKey)) continue;
            if (urlKey && seenUrls.has(urlKey)) continue;

            if (phoneKey) seenPhones.add(phoneKey);
            if (urlKey) seenUrls.add(urlKey);

            allRecords.push(record);
        }
    }

    return { records: allRecords, queriesUsed: queries };
}
```

- [ ] **Step 2: Update `dealer-scraper-service.ts` to load queries from DB**

In `src/lib/dealer-scraper-service.ts`, add import and modify `runDealerScraper`:

Add at top:
```typescript
import { scraperSearchQueries } from '@/lib/db/schema';
```

At the beginning of `runDealerScraper`, before `const { records, queriesUsed } = await scrapeAllDealers();`, add:

```typescript
// Load active queries from DB, fall back to hardcoded
const dbQueries = await db
    .select({ query_text: scraperSearchQueries.query_text })
    .from(scraperSearchQueries)
    .where(eq(scraperSearchQueries.is_active, true));

const customQueries = dbQueries.length > 0
    ? dbQueries.map((q) => q.query_text)
    : undefined;

const { records, queriesUsed } = await scrapeAllDealers(customQueries);
```

- [ ] **Step 3: Verify build**

```bash
npx next build
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/firecrawl.ts src/lib/dealer-scraper-service.ts
git commit -m "feat(scraper): engine reads search queries from DB with hardcoded fallback"
```

---

### Task 4: Query Manager UI

**Files:**
- Create: `src/components/scraper/QueryManager.tsx`
- Modify: `src/components/scraper/ScraperDashboard.tsx`

- [ ] **Step 1: Create QueryManager component**

Create `src/components/scraper/QueryManager.tsx`:

```typescript
"use client";

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, ToggleLeft, ToggleRight, Pencil, Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface QueryRow {
    id: string;
    query_text: string;
    is_active: boolean;
    created_by_name: string | null;
    created_at: string;
}

export function QueryManager() {
    const queryClient = useQueryClient();
    const [newQuery, setNewQuery] = useState('');
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editText, setEditText] = useState('');

    const { data: queries = [], isLoading } = useQuery<QueryRow[]>({
        queryKey: ['scraper-queries'],
        queryFn: async () => {
            const res = await fetch('/api/scraper/queries');
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message);
            return json.data;
        },
    });

    const addMutation = useMutation({
        mutationFn: async (query_text: string) => {
            const res = await fetch('/api/scraper/queries', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query_text }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message);
            return json.data;
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['scraper-queries'] });
            setNewQuery('');
        },
    });

    const toggleMutation = useMutation({
        mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
            const res = await fetch(`/api/scraper/queries/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ is_active }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message);
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scraper-queries'] }),
    });

    const updateMutation = useMutation({
        mutationFn: async ({ id, query_text }: { id: string; query_text: string }) => {
            const res = await fetch(`/api/scraper/queries/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query_text }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['scraper-queries'] });
            setEditingId(null);
        },
    });

    const deleteMutation = useMutation({
        mutationFn: async (id: string) => {
            const res = await fetch(`/api/scraper/queries/${id}`, { method: 'DELETE' });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message);
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scraper-queries'] }),
    });

    return (
        <div className="space-y-4">
            {/* Add new query */}
            <div className="flex gap-2">
                <input
                    type="text"
                    value={newQuery}
                    onChange={(e) => setNewQuery(e.target.value)}
                    placeholder="Enter a search query (e.g., '3-wheeler battery dealer Mumbai')"
                    className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && newQuery.trim().length >= 3) {
                            addMutation.mutate(newQuery.trim());
                        }
                    }}
                />
                <Button
                    onClick={() => addMutation.mutate(newQuery.trim())}
                    disabled={addMutation.isPending || newQuery.trim().length < 3}
                    className="bg-teal-600 hover:bg-teal-700 text-white gap-1.5"
                    size="sm"
                >
                    <Plus className="w-4 h-4" />
                    Add
                </Button>
            </div>

            {/* Query list */}
            {isLoading ? (
                <div className="space-y-2">
                    {[1, 2, 3].map((i) => (
                        <div key={i} className="h-12 bg-gray-100 animate-pulse rounded-lg" />
                    ))}
                </div>
            ) : queries.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-8">
                    No queries yet. Add one above to get started.
                </p>
            ) : (
                <div className="space-y-2">
                    {queries.map((q) => (
                        <div
                            key={q.id}
                            className={`flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors ${
                                q.is_active
                                    ? 'bg-white border-gray-100'
                                    : 'bg-gray-50 border-gray-100 opacity-60'
                            }`}
                        >
                            {/* Toggle */}
                            <button
                                onClick={() => toggleMutation.mutate({ id: q.id, is_active: !q.is_active })}
                                className="shrink-0"
                                title={q.is_active ? 'Disable query' : 'Enable query'}
                            >
                                {q.is_active ? (
                                    <ToggleRight className="w-6 h-6 text-teal-600" />
                                ) : (
                                    <ToggleLeft className="w-6 h-6 text-gray-400" />
                                )}
                            </button>

                            {/* Query text or edit input */}
                            {editingId === q.id ? (
                                <div className="flex-1 flex gap-2">
                                    <input
                                        type="text"
                                        value={editText}
                                        onChange={(e) => setEditText(e.target.value)}
                                        className="flex-1 border border-teal-300 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                                        autoFocus
                                    />
                                    <button
                                        onClick={() => updateMutation.mutate({ id: q.id, query_text: editText })}
                                        className="text-teal-600 hover:text-teal-700"
                                    >
                                        <Check className="w-4 h-4" />
                                    </button>
                                    <button
                                        onClick={() => setEditingId(null)}
                                        className="text-gray-400 hover:text-gray-600"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            ) : (
                                <span className="flex-1 text-sm text-gray-700">{q.query_text}</span>
                            )}

                            {/* Actions */}
                            {editingId !== q.id && (
                                <div className="flex gap-1.5 shrink-0">
                                    <button
                                        onClick={() => { setEditingId(q.id); setEditText(q.query_text); }}
                                        className="p-1.5 text-gray-400 hover:text-teal-600 rounded"
                                        title="Edit"
                                    >
                                        <Pencil className="w-3.5 h-3.5" />
                                    </button>
                                    <button
                                        onClick={() => {
                                            if (confirm('Delete this query?')) deleteMutation.mutate(q.id);
                                        }}
                                        className="p-1.5 text-gray-400 hover:text-red-600 rounded"
                                        title="Delete"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            <p className="text-xs text-gray-400">
                Active queries are used when the scraper runs. Inactive queries are skipped.
            </p>
        </div>
    );
}
```

- [ ] **Step 2: Add tab UI to ScraperDashboard**

Modify `src/components/scraper/ScraperDashboard.tsx` to add a tab toggle between "Run History" and "Search Queries":

Import `QueryManager` and add a `tab` state. Replace the run history section with a tabbed view:

```typescript
import { QueryManager } from './QueryManager';

// Add inside the component:
const [tab, setTab] = useState<'history' | 'queries'>('history');
```

Replace the `{/* Run history */}` section (lines 91-95) with:

```tsx
{/* Tabs */}
<div className="flex gap-1 bg-gray-100 rounded-lg p-1 w-fit">
    <button
        onClick={() => setTab('history')}
        className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            tab === 'history' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
        }`}
    >
        Run History
    </button>
    <button
        onClick={() => setTab('queries')}
        className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors ${
            tab === 'queries' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
        }`}
    >
        Search Queries
    </button>
</div>

{/* Tab content */}
{tab === 'history' ? (
    <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Run History</h2>
        <ScraperRunsTable />
    </div>
) : (
    <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Manage Search Queries</h2>
        <QueryManager />
    </div>
)}
```

- [ ] **Step 3: Verify build**

```bash
npx next build
```

- [ ] **Step 4: Commit**

```bash
git add src/components/scraper/QueryManager.tsx src/components/scraper/ScraperDashboard.tsx
git commit -m "feat(scraper): add query manager UI with tabs on dashboard"
```

---

## Chunk 2: Smart Search + Better Extraction

### Task 5: Better Extraction — Expand Zod Schema + DB Columns

**Files:**
- Modify: `src/lib/firecrawl.ts` (lines 35-45, `DealerExtractSchema`)
- Modify: `src/lib/db/schema.ts` (lines 1373-1402, `scrapedDealerLeads`)
- Modify: `src/types/scraper.ts` (lines 55-62, `RawDealerRecord`)
- Modify: migration SQL

- [ ] **Step 1: Add new columns to `scrapedDealerLeads` in schema.ts**

In `src/lib/db/schema.ts`, add these columns to the `scrapedDealerLeads` table, after `raw_data` (line 1381):

```typescript
    email: varchar('email', { length: 255 }),
    gst_number: varchar('gst_number', { length: 20 }),
    business_type: varchar('business_type', { length: 50 }),    // distributor, dealer, wholesaler, retailer
    products_sold: text('products_sold'),
    website: text('website'),
    quality_score: integer('quality_score'),                     // 1-5 based on data completeness
    phone_valid: boolean('phone_valid'),
```

- [ ] **Step 2: Update RawDealerRecord type**

In `src/types/scraper.ts`, update `RawDealerRecord`:

```typescript
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
```

- [ ] **Step 3: Update Firecrawl extraction schema**

In `src/lib/firecrawl.ts`, replace `DealerExtractSchema` (lines 35-45):

```typescript
const DealerExtractSchema = z.object({
    dealers: z.array(
        z.object({
            dealer_name: z.string().describe('Name of the dealer or business'),
            phone: z.string().optional().describe('Primary contact phone number'),
            city: z.string().optional().describe('City where the dealer is located'),
            state: z.string().optional().describe('State/region where the dealer is located'),
            address: z.string().optional().describe('Full address if available'),
            email: z.string().optional().describe('Email address if available'),
            gst_number: z.string().optional().describe('GST number / GSTIN if available'),
            business_type: z.string().optional().describe('Type: distributor, dealer, wholesaler, or retailer'),
            products_sold: z.string().optional().describe('Products or brands they sell'),
            website: z.string().optional().describe('Website URL if available'),
        })
    ).describe('List of 3-wheeler battery dealers found on the page'),
});
```

- [ ] **Step 4: Update `searchDealers` to pass new fields through**

In `src/lib/firecrawl.ts`, update the record push in `searchDealers` (around line 112-119):

```typescript
results.push({
    dealer_name: d.dealer_name.trim(),
    phone: normalizePhone(d.phone) ?? undefined,
    city: d.city?.trim(),
    state: d.state?.trim(),
    address: d.address?.trim(),
    source_url: pageUrl,
    email: d.email?.trim(),
    gst_number: d.gst_number?.trim(),
    business_type: d.business_type?.trim()?.toLowerCase(),
    products_sold: d.products_sold?.trim(),
    website: d.website?.trim(),
});
```

- [ ] **Step 5: Generate and apply migration**

```bash
npx drizzle-kit generate
npx drizzle-kit push
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/schema.ts src/lib/firecrawl.ts src/types/scraper.ts drizzle/
git commit -m "feat(scraper): expand extraction schema with email, GST, business type, quality score"
```

---

### Task 6: Data Enrichment Pipeline

**Files:**
- Create: `src/lib/scraper-enrichment.ts`
- Modify: `src/lib/dealer-scraper-service.ts`

- [ ] **Step 1: Create enrichment module**

Create `src/lib/scraper-enrichment.ts`:

```typescript
import type { RawDealerRecord } from '@/types/scraper';

// City name normalization map
const CITY_ALIASES: Record<string, string> = {
    'blr': 'Bengaluru', 'bangalore': 'Bengaluru', 'bengaluru': 'Bengaluru',
    'dl': 'Delhi', 'new delhi': 'Delhi', 'delhi': 'Delhi',
    'mum': 'Mumbai', 'bombay': 'Mumbai', 'mumbai': 'Mumbai',
    'chn': 'Chennai', 'madras': 'Chennai', 'chennai': 'Chennai',
    'kol': 'Kolkata', 'calcutta': 'Kolkata', 'kolkata': 'Kolkata',
    'hyd': 'Hyderabad', 'hyderabad': 'Hyderabad',
    'ahd': 'Ahmedabad', 'amd': 'Ahmedabad', 'ahmedabad': 'Ahmedabad',
    'pune': 'Pune', 'pnq': 'Pune',
    'jpr': 'Jaipur', 'jaipur': 'Jaipur',
    'lko': 'Lucknow', 'lucknow': 'Lucknow',
    'pat': 'Patna', 'patna': 'Patna',
    'ind': 'Indore', 'indore': 'Indore',
    'bpl': 'Bhopal', 'bhopal': 'Bhopal',
    'ngp': 'Nagpur', 'nagpur': 'Nagpur',
    'guwahati': 'Guwahati', 'ghy': 'Guwahati',
};

const STATE_ALIASES: Record<string, string> = {
    'up': 'Uttar Pradesh', 'uttar pradesh': 'Uttar Pradesh',
    'mp': 'Madhya Pradesh', 'madhya pradesh': 'Madhya Pradesh',
    'mh': 'Maharashtra', 'maharashtra': 'Maharashtra',
    'ka': 'Karnataka', 'karnataka': 'Karnataka',
    'tn': 'Tamil Nadu', 'tamil nadu': 'Tamil Nadu',
    'wb': 'West Bengal', 'west bengal': 'West Bengal',
    'rj': 'Rajasthan', 'rajasthan': 'Rajasthan',
    'gj': 'Gujarat', 'gujarat': 'Gujarat',
    'ap': 'Andhra Pradesh', 'andhra pradesh': 'Andhra Pradesh',
    'ts': 'Telangana', 'telangana': 'Telangana',
    'dl': 'Delhi', 'delhi': 'Delhi',
    'br': 'Bihar', 'bihar': 'Bihar',
    'hr': 'Haryana', 'haryana': 'Haryana',
    'pb': 'Punjab', 'punjab': 'Punjab',
    'or': 'Odisha', 'odisha': 'Odisha',
    'jh': 'Jharkhand', 'jharkhand': 'Jharkhand',
    'cg': 'Chhattisgarh', 'chhattisgarh': 'Chhattisgarh',
    'as': 'Assam', 'assam': 'Assam',
    'uk': 'Uttarakhand', 'uttarakhand': 'Uttarakhand',
};

export function normalizeCity(city: string | undefined): string | undefined {
    if (!city) return undefined;
    const key = city.trim().toLowerCase();
    return CITY_ALIASES[key] ?? city.trim();
}

export function normalizeState(state: string | undefined): string | undefined {
    if (!state) return undefined;
    const key = state.trim().toLowerCase();
    return STATE_ALIASES[key] ?? state.trim();
}

export function isPhoneValid(phone: string | undefined): boolean {
    if (!phone) return false;
    // Already normalized to +91XXXXXXXXXX format by normalizePhone
    return /^\+91\d{10}$/.test(phone);
}

export function calculateQualityScore(record: RawDealerRecord): number {
    let score = 0;
    if (record.phone) score++;
    if (record.city) score++;
    if (record.dealer_name && record.dealer_name.length > 3) score++;
    if (record.source_url) score++;
    if (record.state || record.address) score++;
    return Math.max(1, score); // minimum 1
}

export function enrichRecord(record: RawDealerRecord): RawDealerRecord & {
    quality_score: number;
    phone_valid: boolean;
} {
    return {
        ...record,
        city: normalizeCity(record.city),
        state: normalizeState(record.state),
        quality_score: calculateQualityScore(record),
        phone_valid: isPhoneValid(record.phone),
    };
}
```

- [ ] **Step 2: Integrate enrichment into scraper service**

In `src/lib/dealer-scraper-service.ts`, add import and use enrichment:

```typescript
import { enrichRecord } from '@/lib/scraper-enrichment';
```

In the `runDealerScraper` function, in the "New lead – persist" block (around line 123-135), replace with:

```typescript
// New lead – enrich and persist
const enriched = enrichRecord(record);
await db.insert(scrapedDealerLeads).values({
    id: await generateId('SDL', scrapedDealerLeads),
    scraper_run_id: runId,
    dealer_name: enriched.dealer_name,
    phone: enriched.phone ?? null,
    location_city: enriched.city ?? null,
    location_state: enriched.state ?? null,
    source_url: enriched.source_url ?? null,
    raw_data: record as unknown as Record<string, unknown>,
    email: enriched.email ?? null,
    gst_number: enriched.gst_number ?? null,
    business_type: enriched.business_type ?? null,
    products_sold: enriched.products_sold ?? null,
    website: enriched.website ?? null,
    quality_score: enriched.quality_score,
    phone_valid: enriched.phone_valid,
    exploration_status: 'unassigned',
});
newLeadsSaved++;
```

- [ ] **Step 3: Verify build**

```bash
npx next build
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/scraper-enrichment.ts src/lib/dealer-scraper-service.ts
git commit -m "feat(scraper): add data enrichment pipeline with quality scoring and normalization"
```

---

### Task 7: Smart Search — Auto-Follow Directory URLs

**Files:**
- Modify: `src/lib/firecrawl.ts`

- [ ] **Step 1: Add directory detection and deep scraping**

In `src/lib/firecrawl.ts`, add after the `normalizePhone` function (after line 69):

```typescript
// Known directory domains for deep scraping
const DIRECTORY_DOMAINS = [
    'justdial.com',
    'indiamart.com',
    'sulekha.com',
    'tradeindia.com',
    'exportersindia.com',
    'google.com/maps',
    'google.co.in/maps',
];

function isDirectoryUrl(url: string): boolean {
    try {
        const hostname = new URL(url).hostname.replace('www.', '');
        const fullUrl = url.toLowerCase();
        return DIRECTORY_DOMAINS.some(
            (domain) => hostname.includes(domain) || fullUrl.includes(domain)
        );
    } catch {
        return false;
    }
}

export async function scrapeDirectoryPage(url: string): Promise<RawDealerRecord[]> {
    const app = getClient();
    const results: RawDealerRecord[] = [];

    try {
        const scrapeResponse = await app.scrapeUrl(url, {
            formats: [
                {
                    type: 'json',
                    schema: DealerExtractSchema,
                    prompt:
                        'Extract every 3-wheeler battery dealer from this page. ' +
                        'Include dealer name, phone number, city, state, email, GST number, ' +
                        'business type, products sold, and website. Only extract dealers.',
                } as { type: 'json'; schema: typeof DealerExtractSchema; prompt: string },
            ],
        });

        const parsed = DealerExtractSchema.safeParse(
            (scrapeResponse as { json?: unknown }).json
        );
        if (!parsed.success || !parsed.data.dealers?.length) return results;

        for (const d of parsed.data.dealers) {
            if (!d.dealer_name) continue;
            results.push({
                dealer_name: d.dealer_name.trim(),
                phone: normalizePhone(d.phone) ?? undefined,
                city: d.city?.trim(),
                state: d.state?.trim(),
                address: d.address?.trim(),
                source_url: url,
                email: (d as Record<string, unknown>).email as string | undefined,
                gst_number: (d as Record<string, unknown>).gst_number as string | undefined,
                business_type: ((d as Record<string, unknown>).business_type as string | undefined)?.toLowerCase(),
                products_sold: (d as Record<string, unknown>).products_sold as string | undefined,
                website: (d as Record<string, unknown>).website as string | undefined,
            });
        }
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[Firecrawl] Error scraping directory page "${url}":`, msg);
    }

    return results;
}
```

- [ ] **Step 2: Update `scrapeAllDealers` to auto-follow directories**

Replace `scrapeAllDealers` with:

```typescript
export async function scrapeAllDealers(customQueries?: string[]): Promise<{
    records: RawDealerRecord[];
    queriesUsed: string[];
}> {
    const queries = customQueries ?? DEALER_SEARCH_QUERIES;
    const allRecords: RawDealerRecord[] = [];
    const seenPhones = new Set<string>();
    const seenUrls = new Set<string>();
    const directoryUrlsToScrape = new Set<string>();

    // Phase 1: Search queries
    for (const query of queries) {
        const batch = await searchDealers(query);
        for (const record of batch) {
            const phoneKey = record.phone;
            const urlKey = record.source_url ? record.source_url.split('?')[0] : null;

            if (phoneKey && seenPhones.has(phoneKey)) continue;
            if (urlKey && seenUrls.has(urlKey)) continue;

            if (phoneKey) seenPhones.add(phoneKey);
            if (urlKey) seenUrls.add(urlKey);

            allRecords.push(record);

            // Collect directory URLs for deep scraping
            if (record.source_url && isDirectoryUrl(record.source_url)) {
                const normalizedUrl = record.source_url.split('?')[0];
                if (!directoryUrlsToScrape.has(normalizedUrl)) {
                    directoryUrlsToScrape.add(normalizedUrl);
                }
            }
        }
    }

    // Phase 2: Deep scrape directory pages (max 5 to stay within limits)
    const urlsToScrape = Array.from(directoryUrlsToScrape).slice(0, 5);
    for (const url of urlsToScrape) {
        const deepResults = await scrapeDirectoryPage(url);
        for (const record of deepResults) {
            const phoneKey = record.phone;
            const urlKey = record.source_url ? record.source_url.split('?')[0] : null;

            if (phoneKey && seenPhones.has(phoneKey)) continue;
            if (urlKey && seenUrls.has(urlKey)) continue;

            if (phoneKey) seenPhones.add(phoneKey);
            if (urlKey) seenUrls.add(urlKey);

            allRecords.push(record);
        }
    }

    return { records: allRecords, queriesUsed: queries };
}
```

- [ ] **Step 3: Verify build**

```bash
npx next build
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/firecrawl.ts
git commit -m "feat(scraper): smart search auto-follows directory URLs for deeper results"
```

---

## Chunk 3: Lead Conversion + UI Enhancements

### Task 8: Lead Conversion API

**Files:**
- Create: `src/app/api/scraper/leads/[id]/convert/route.ts`

- [ ] **Step 1: Create conversion endpoint**

Create `src/app/api/scraper/leads/[id]/convert/route.ts`:

```typescript
import { db } from '@/lib/db';
import { scrapedDealerLeads, auditLogs } from '@/lib/db/schema';
import { generateId, withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const convertSchema = z.object({
    converted_lead_id: z.string().min(1),
});

export const PATCH = withErrorHandler(
    async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
        const user = await requireRole(['sales_manager', 'sales_head', 'ceo', 'business_head']);
        const { id: leadId } = await params;

        const body = await req.json();
        const result = convertSchema.safeParse(body);
        if (!result.success) return errorResponse(result.error.issues[0].message, 400);

        // Verify the scraped lead exists
        const [lead] = await db
            .select({
                id: scrapedDealerLeads.id,
                dealer_name: scrapedDealerLeads.dealer_name,
                converted_lead_id: scrapedDealerLeads.converted_lead_id,
            })
            .from(scrapedDealerLeads)
            .where(eq(scrapedDealerLeads.id, leadId))
            .limit(1);

        if (!lead) return errorResponse('Scraped lead not found', 404);
        if (lead.converted_lead_id) return errorResponse('Lead already converted', 409);

        await db
            .update(scrapedDealerLeads)
            .set({
                converted_lead_id: result.data.converted_lead_id,
                exploration_status: 'explored',
                explored_at: new Date(),
                updated_at: new Date(),
            })
            .where(eq(scrapedDealerLeads.id, leadId));

        await db.insert(auditLogs).values({
            id: await generateId('AUDIT', auditLogs),
            entity_type: 'scraped_lead',
            entity_id: leadId,
            action: 'converted_to_crm_lead',
            changes: {
                dealer_name: lead.dealer_name,
                converted_lead_id: result.data.converted_lead_id,
            },
            performed_by: user.id,
            timestamp: new Date(),
        });

        return successResponse({ message: 'Lead converted', converted_lead_id: result.data.converted_lead_id });
    }
);
```

- [ ] **Step 2: Add `GET` to fetch single scraped lead (for pre-fill)**

Create `src/app/api/scraper/leads/[id]/route.ts`:

```typescript
import { db } from '@/lib/db';
import { scrapedDealerLeads } from '@/lib/db/schema';
import { withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { eq } from 'drizzle-orm';

export const GET = withErrorHandler(
    async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
        await requireRole(['sales_manager', 'sales_head', 'ceo', 'business_head']);
        const { id } = await params;

        const [lead] = await db
            .select()
            .from(scrapedDealerLeads)
            .where(eq(scrapedDealerLeads.id, id))
            .limit(1);

        if (!lead) return errorResponse('Lead not found', 404);
        return successResponse(lead);
    }
);
```

- [ ] **Step 3: Commit**

```bash
git add src/app/api/scraper/leads/[id]/convert/ src/app/api/scraper/leads/[id]/route.ts
git commit -m "feat(scraper): add lead conversion API and single lead GET endpoint"
```

---

### Task 9: Lead Conversion UI — "Convert to Lead" Button

**Files:**
- Modify: `src/components/scraper/SalesManagerLeadsView.tsx`
- Modify: `src/components/scraper/ScrapedLeadsTable.tsx`
- Modify: `src/app/(dashboard)/dealer-portal/leads/new/page.tsx` (pre-fill support)

- [ ] **Step 1: Add "Convert to Lead" button in SalesManagerLeadsView**

In `src/components/scraper/SalesManagerLeadsView.tsx`, add to the `LeadDetailDrawer` component, after the Save button (around line 162), inside the `<div className="flex gap-2">`:

```tsx
{(lead.exploration_status === 'explored' || lead.exploration_status === 'exploring') && (
    <Button
        size="sm"
        className="bg-blue-600 hover:bg-blue-700 text-white text-xs gap-1.5 ml-auto"
        onClick={() => {
            const params = new URLSearchParams({
                from_scraped: lead.id,
                name: lead.dealer_name,
                phone: lead.phone ?? '',
                city: lead.location_city ?? '',
                state: lead.location_state ?? '',
            });
            window.open(`/dealer-portal/leads/new?${params}`, '_blank');
        }}
    >
        Convert to CRM Lead
    </Button>
)}
```

Add `converted_lead_id` to the `LeadRow` interface:

```typescript
converted_lead_id: string | null;
```

Show a badge if already converted, before the convert button:

```tsx
{lead.converted_lead_id && (
    <a
        href={`/dealer-portal/leads/${lead.converted_lead_id}/kyc`}
        className="text-xs text-blue-600 underline"
    >
        View CRM Lead
    </a>
)}
```

- [ ] **Step 2: Add pre-fill support in leads/new/page.tsx**

In `src/app/(dashboard)/dealer-portal/leads/new/page.tsx`, inside `NewLeadWizardContent`, after the `searchParams` line (around line 23), add pre-fill logic:

```typescript
const fromScraped = searchParams.get('from_scraped');
const prefillName = searchParams.get('name');
const prefillPhone = searchParams.get('phone');
const prefillCity = searchParams.get('city');
const prefillState = searchParams.get('state');
```

Then in the `useEffect` or `useState` for `formData`, set initial values if prefill params exist:

```typescript
// In the formData useState initial value or in a useEffect:
useEffect(() => {
    if (prefillName || prefillPhone) {
        setFormData((prev: any) => ({
            ...prev,
            full_name: prefillName || prev.full_name,
            phone: prefillPhone || prev.phone,
            current_address: prefillCity ? `${prefillCity}${prefillState ? ', ' + prefillState : ''}` : prev.current_address,
        }));
    }
}, [prefillName, prefillPhone, prefillCity, prefillState]);
```

After successful lead creation (when `leadId` is set), if `from_scraped` param exists, call the convert API:

```typescript
// After lead is created successfully and leadId is available:
if (fromScraped && leadId) {
    fetch(`/api/scraper/leads/${fromScraped}/convert`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ converted_lead_id: leadId }),
    }).catch(console.error);
}
```

- [ ] **Step 3: Verify build**

```bash
npx next build
```

- [ ] **Step 4: Commit**

```bash
git add src/components/scraper/SalesManagerLeadsView.tsx src/app/(dashboard)/dealer-portal/leads/new/page.tsx
git commit -m "feat(scraper): add Convert to CRM Lead button with pre-fill support"
```

---

### Task 10: Enhanced Lead Detail UI (Quality Score + Extra Fields)

**Files:**
- Modify: `src/components/scraper/SalesManagerLeadsView.tsx`
- Modify: `src/components/scraper/ScrapedLeadsTable.tsx`
- Create: `src/components/scraper/QualityScoreBadge.tsx`

- [ ] **Step 1: Create QualityScoreBadge component**

Create `src/components/scraper/QualityScoreBadge.tsx`:

```typescript
export function QualityScoreBadge({ score }: { score: number | null }) {
    if (score === null || score === undefined) return null;

    const colors: Record<number, string> = {
        1: 'bg-red-100 text-red-700',
        2: 'bg-orange-100 text-orange-700',
        3: 'bg-yellow-100 text-yellow-700',
        4: 'bg-green-100 text-green-700',
        5: 'bg-emerald-100 text-emerald-700',
    };

    return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${colors[score] ?? 'bg-gray-100 text-gray-700'}`}>
            Q{score}/5
        </span>
    );
}
```

- [ ] **Step 2: Add extra fields + quality score to LeadDetailDrawer**

In `src/components/scraper/SalesManagerLeadsView.tsx`, update the `LeadRow` interface to include new fields:

```typescript
interface LeadRow {
    id: string;
    dealer_name: string;
    phone: string | null;
    location_city: string | null;
    location_state: string | null;
    source_url: string | null;
    exploration_status: string;
    exploration_notes: string | null;
    assigned_at: string | null;
    created_at: string;
    converted_lead_id: string | null;
    email: string | null;
    gst_number: string | null;
    business_type: string | null;
    products_sold: string | null;
    website: string | null;
    quality_score: number | null;
    phone_valid: boolean | null;
}
```

In the `LeadDetailDrawer`, add the extra fields to the contact info grid:

```tsx
{lead.email && (
    <div>
        <p className="text-xs text-gray-400 mb-0.5">Email</p>
        <a href={`mailto:${lead.email}`} className="text-teal-600 text-sm">{lead.email}</a>
    </div>
)}
{lead.gst_number && (
    <div>
        <p className="text-xs text-gray-400 mb-0.5">GST Number</p>
        <span className="text-sm text-gray-700">{lead.gst_number}</span>
    </div>
)}
{lead.business_type && (
    <div>
        <p className="text-xs text-gray-400 mb-0.5">Business Type</p>
        <span className="text-sm text-gray-700 capitalize">{lead.business_type}</span>
    </div>
)}
{lead.website && (
    <div>
        <p className="text-xs text-gray-400 mb-0.5">Website</p>
        <a href={lead.website} target="_blank" rel="noopener noreferrer" className="text-blue-500 text-sm">{lead.website}</a>
    </div>
)}
{lead.products_sold && (
    <div className="col-span-2">
        <p className="text-xs text-gray-400 mb-0.5">Products</p>
        <span className="text-sm text-gray-700">{lead.products_sold}</span>
    </div>
)}
```

Add quality score badge next to the dealer name in the accordion:

```tsx
import { QualityScoreBadge } from './QualityScoreBadge';

// In the accordion button, after ExplorationStatusBadge:
<QualityScoreBadge score={lead.quality_score} />
```

Add phone validity warning:

```tsx
{lead.phone && lead.phone_valid === false && (
    <span className="text-xs text-orange-500 ml-1">(unverified)</span>
)}
```

- [ ] **Step 3: Update ScrapedLeadsTable with quality score column**

In `src/components/scraper/ScrapedLeadsTable.tsx`, add a quality score column to the table.

- [ ] **Step 4: Verify build**

```bash
npx next build
```

- [ ] **Step 5: Commit**

```bash
git add src/components/scraper/QualityScoreBadge.tsx src/components/scraper/SalesManagerLeadsView.tsx src/components/scraper/ScrapedLeadsTable.tsx
git commit -m "feat(scraper): add quality score badges, extra fields display, and phone validation UI"
```

---

## Chunk 4: Scheduled Runs

### Task 11: DB Schema — `scraper_schedules` table

**Files:**
- Modify: `src/lib/db/schema.ts`
- Modify: `src/types/scraper.ts`

- [ ] **Step 1: Add Drizzle schema for `scraper_schedules`**

In `src/lib/db/schema.ts`, after the `scraperSearchQueries` table, add:

```typescript
export const scraperSchedules = pgTable('scraper_schedules', {
    id: varchar('id', { length: 255 }).primaryKey(),             // SCHED-YYYYMMDD-SEQ
    frequency: varchar('frequency', { length: 20 }).notNull(),   // every_2_days, weekly, biweekly, monthly
    day_of_week: integer('day_of_week'),                          // 0-6 (Sunday-Saturday), for weekly/biweekly
    time_of_day: varchar('time_of_day', { length: 5 }).notNull().default('03:00'), // HH:MM in IST
    is_active: boolean('is_active').notNull().default(true),
    last_run_at: timestamp('last_run_at', { withTimezone: true }),
    created_by: uuid('created_by').references(() => users.id).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const scraperSchedulesRelations = relations(scraperSchedules, ({ one }) => ({
    createdBy: one(users, { fields: [scraperSchedules.created_by], references: [users.id] }),
}));
```

- [ ] **Step 2: Add types**

In `src/types/scraper.ts`:

```typescript
export type ScraperSchedule = InferSelectModel<typeof schema.scraperSchedules>;
export type NewScraperSchedule = InferInsertModel<typeof schema.scraperSchedules>;

export type ScheduleFrequency = 'every_2_days' | 'weekly' | 'biweekly' | 'monthly';
```

- [ ] **Step 3: Generate and apply migration**

```bash
npx drizzle-kit generate
npx drizzle-kit push
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/db/schema.ts src/types/scraper.ts drizzle/
git commit -m "feat(scraper): add scraper_schedules table schema"
```

---

### Task 12: Schedule API + Cron Endpoint

**Files:**
- Create: `src/app/api/scraper/schedule/route.ts`
- Create: `src/app/api/scraper/cron/route.ts`
- Modify: `vercel.json`

- [ ] **Step 1: Create schedule CRUD API**

Create `src/app/api/scraper/schedule/route.ts`:

```typescript
import { db } from '@/lib/db';
import { scraperSchedules } from '@/lib/db/schema';
import { generateId, withErrorHandler, successResponse, errorResponse } from '@/lib/api-utils';
import { requireRole } from '@/lib/auth-utils';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

const scheduleSchema = z.object({
    frequency: z.enum(['every_2_days', 'weekly', 'biweekly', 'monthly']),
    day_of_week: z.number().min(0).max(6).optional(),
    time_of_day: z.string().regex(/^\d{2}:\d{2}$/).optional().default('03:00'),
    is_active: z.boolean().optional().default(true),
});

// GET — get current active schedule
export const GET = withErrorHandler(async () => {
    await requireRole(['sales_head', 'ceo', 'business_head']);

    const [schedule] = await db
        .select()
        .from(scraperSchedules)
        .where(eq(scraperSchedules.is_active, true))
        .limit(1);

    return successResponse(schedule ?? null);
});

// POST — create or update schedule (only one active at a time)
export const POST = withErrorHandler(async (req: Request) => {
    const user = await requireRole(['sales_head', 'ceo', 'business_head']);

    const body = await req.json();
    const result = scheduleSchema.safeParse(body);
    if (!result.success) return errorResponse(result.error.issues[0].message, 400);

    // Deactivate all existing schedules
    await db.update(scraperSchedules).set({ is_active: false, updated_at: new Date() });

    if (!result.data.is_active) {
        return successResponse({ message: 'Schedule disabled' });
    }

    const id = await generateId('SCHED', scraperSchedules);
    await db.insert(scraperSchedules).values({
        id,
        frequency: result.data.frequency,
        day_of_week: result.data.day_of_week ?? null,
        time_of_day: result.data.time_of_day,
        is_active: true,
        created_by: user.id,
    });

    return successResponse({ id, message: 'Schedule set' }, 201);
});

// DELETE — disable schedule
export const DELETE = withErrorHandler(async () => {
    await requireRole(['sales_head', 'ceo', 'business_head']);

    await db.update(scraperSchedules).set({ is_active: false, updated_at: new Date() });
    return successResponse({ message: 'Schedule disabled' });
});
```

- [ ] **Step 2: Create cron endpoint**

Create `src/app/api/scraper/cron/route.ts`:

```typescript
import { db } from '@/lib/db';
import { scraperSchedules, scraperRuns } from '@/lib/db/schema';
import { generateId, successResponse } from '@/lib/api-utils';
import { runDealerScraper } from '@/lib/dealer-scraper-service';
import { eq } from 'drizzle-orm';

export const maxDuration = 300;

function isDue(schedule: {
    frequency: string;
    day_of_week: number | null;
    time_of_day: string;
    last_run_at: Date | null;
}): boolean {
    const now = new Date();
    const lastRun = schedule.last_run_at;

    if (!lastRun) return true; // Never run before

    const hoursSinceLastRun = (now.getTime() - lastRun.getTime()) / (1000 * 60 * 60);

    switch (schedule.frequency) {
        case 'every_2_days':
            return hoursSinceLastRun >= 48;
        case 'weekly':
            return hoursSinceLastRun >= 168;
        case 'biweekly':
            return hoursSinceLastRun >= 336;
        case 'monthly':
            return hoursSinceLastRun >= 720;
        default:
            return false;
    }
}

export const GET = async (req: Request) => {
    // Verify cron secret (Vercel sets CRON_SECRET automatically)
    const authHeader = req.headers.get('authorization');
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return new Response('Unauthorized', { status: 401 });
    }

    // Get active schedule
    const [schedule] = await db
        .select()
        .from(scraperSchedules)
        .where(eq(scraperSchedules.is_active, true))
        .limit(1);

    if (!schedule) {
        return successResponse({ message: 'No active schedule', triggered: false });
    }

    if (!isDue(schedule)) {
        return successResponse({ message: 'Not due yet', triggered: false });
    }

    // Check if a run is already in progress
    const [running] = await db
        .select({ id: scraperRuns.id })
        .from(scraperRuns)
        .where(eq(scraperRuns.status, 'running'))
        .limit(1);

    if (running) {
        return successResponse({ message: 'Run already in progress', triggered: false });
    }

    // Trigger the run
    const runId = await generateId('SCRAPE', scraperRuns);
    await db.insert(scraperRuns).values({
        id: runId,
        triggered_by: schedule.created_by, // attribute to schedule creator
        status: 'running',
        started_at: new Date(),
    });

    // Update last_run_at
    await db
        .update(scraperSchedules)
        .set({ last_run_at: new Date(), updated_at: new Date() })
        .where(eq(scraperSchedules.id, schedule.id));

    // Fire and forget
    runDealerScraper(runId).catch((err) =>
        console.error(`[Scraper Cron] Background run failed for ${runId}:`, err)
    );

    return successResponse({ message: 'Scraper triggered by schedule', run_id: runId, triggered: true });
};
```

- [ ] **Step 3: Update vercel.json**

Add the scraper cron job with 25-hour frequency. Since cron syntax doesn't support "every 25 hours" directly, use a daily schedule that the endpoint's `isDue` logic will gate:

```json
{
  "crons": [
    {
      "path": "/api/cron/ai-dialer",
      "schedule": "0 3 * * *"
    },
    {
      "path": "/api/scraper/cron",
      "schedule": "0 4 * * *"
    }
  ]
}
```

The cron fires daily at 4 AM, but the `isDue` function ensures the scraper only runs when the configured frequency interval has elapsed (minimum 48 hours).

- [ ] **Step 4: Verify build**

```bash
npx next build
```

- [ ] **Step 5: Commit**

```bash
git add src/app/api/scraper/schedule/ src/app/api/scraper/cron/ vercel.json
git commit -m "feat(scraper): add scheduled runs with Vercel cron and configurable frequency"
```

---

### Task 13: Schedule Config UI

**Files:**
- Create: `src/components/scraper/ScheduleConfig.tsx`
- Modify: `src/components/scraper/ScraperDashboard.tsx`

- [ ] **Step 1: Create ScheduleConfig component**

Create `src/components/scraper/ScheduleConfig.tsx`:

```typescript
"use client";

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Clock, Power, PowerOff } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Schedule {
    id: string;
    frequency: string;
    day_of_week: number | null;
    time_of_day: string;
    is_active: boolean;
    last_run_at: string | null;
}

const FREQUENCY_OPTIONS = [
    { value: 'every_2_days', label: 'Every 2 Days' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'biweekly', label: 'Every 2 Weeks' },
    { value: 'monthly', label: 'Monthly' },
];

const DAY_OPTIONS = [
    { value: 0, label: 'Sunday' },
    { value: 1, label: 'Monday' },
    { value: 2, label: 'Tuesday' },
    { value: 3, label: 'Wednesday' },
    { value: 4, label: 'Thursday' },
    { value: 5, label: 'Friday' },
    { value: 6, label: 'Saturday' },
];

export function ScheduleConfig() {
    const queryClient = useQueryClient();
    const [frequency, setFrequency] = useState('every_2_days');
    const [dayOfWeek, setDayOfWeek] = useState(1);
    const [timeOfDay, setTimeOfDay] = useState('03:00');

    const { data: schedule, isLoading } = useQuery<Schedule | null>({
        queryKey: ['scraper-schedule'],
        queryFn: async () => {
            const res = await fetch('/api/scraper/schedule');
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message);
            return json.data;
        },
    });

    useEffect(() => {
        if (schedule) {
            setFrequency(schedule.frequency);
            setDayOfWeek(schedule.day_of_week ?? 1);
            setTimeOfDay(schedule.time_of_day);
        }
    }, [schedule]);

    const saveMutation = useMutation({
        mutationFn: async (active: boolean) => {
            const res = await fetch('/api/scraper/schedule', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    frequency,
                    day_of_week: ['weekly', 'biweekly'].includes(frequency) ? dayOfWeek : undefined,
                    time_of_day: timeOfDay,
                    is_active: active,
                }),
            });
            const json = await res.json();
            if (!json.success) throw new Error(json.error?.message);
        },
        onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scraper-schedule'] }),
    });

    const showDayPicker = ['weekly', 'biweekly'].includes(frequency);

    if (isLoading) {
        return <div className="h-32 bg-gray-100 animate-pulse rounded-xl" />;
    }

    return (
        <div className="bg-white border border-gray-100 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Clock className="w-4 h-4 text-teal-600" />
                    <h3 className="text-sm font-semibold text-gray-700">Auto Schedule</h3>
                </div>
                {schedule?.is_active ? (
                    <span className="flex items-center gap-1 text-xs text-green-600 bg-green-50 px-2 py-1 rounded-full">
                        <Power className="w-3 h-3" /> Active
                    </span>
                ) : (
                    <span className="flex items-center gap-1 text-xs text-gray-400 bg-gray-50 px-2 py-1 rounded-full">
                        <PowerOff className="w-3 h-3" /> Off
                    </span>
                )}
            </div>

            <div className="grid grid-cols-2 gap-3">
                <div>
                    <label className="block text-xs text-gray-500 mb-1">Frequency</label>
                    <select
                        value={frequency}
                        onChange={(e) => setFrequency(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                    >
                        {FREQUENCY_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                    </select>
                </div>

                <div>
                    <label className="block text-xs text-gray-500 mb-1">Time (IST)</label>
                    <input
                        type="time"
                        value={timeOfDay}
                        onChange={(e) => setTimeOfDay(e.target.value)}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                    />
                </div>
            </div>

            {showDayPicker && (
                <div>
                    <label className="block text-xs text-gray-500 mb-1">Day</label>
                    <select
                        value={dayOfWeek}
                        onChange={(e) => setDayOfWeek(Number(e.target.value))}
                        className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                    >
                        {DAY_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                    </select>
                </div>
            )}

            {schedule?.last_run_at && (
                <p className="text-xs text-gray-400">
                    Last auto-run: {new Date(schedule.last_run_at).toLocaleString('en-IN')}
                </p>
            )}

            <div className="flex gap-2">
                <Button
                    size="sm"
                    className="bg-teal-600 hover:bg-teal-700 text-white text-xs"
                    onClick={() => saveMutation.mutate(true)}
                    disabled={saveMutation.isPending}
                >
                    {saveMutation.isPending ? 'Saving…' : 'Save & Enable'}
                </Button>
                {schedule?.is_active && (
                    <Button
                        size="sm"
                        variant="outline"
                        className="text-xs"
                        onClick={() => saveMutation.mutate(false)}
                        disabled={saveMutation.isPending}
                    >
                        Disable
                    </Button>
                )}
            </div>
        </div>
    );
}
```

- [ ] **Step 2: Add ScheduleConfig to ScraperDashboard**

In `src/components/scraper/ScraperDashboard.tsx`, import and add below the info cards grid:

```typescript
import { ScheduleConfig } from './ScheduleConfig';
```

Add after the info cards section (after line 89, `</div>`):

```tsx
<ScheduleConfig />
```

- [ ] **Step 3: Verify build**

```bash
npx next build
```

- [ ] **Step 4: Commit**

```bash
git add src/components/scraper/ScheduleConfig.tsx src/components/scraper/ScraperDashboard.tsx
git commit -m "feat(scraper): add schedule configuration UI on dashboard"
```

---

### Task 14: Update Leads API to Return New Fields

**Files:**
- Modify: `src/app/api/scraper/leads/route.ts`
- Modify: `src/app/api/scraper/runs/[id]/route.ts`

- [ ] **Step 1: Update leads list API to include new fields**

In `src/app/api/scraper/leads/route.ts`, add the new columns to the `select()` call:

```typescript
email: scrapedDealerLeads.email,
gst_number: scrapedDealerLeads.gst_number,
business_type: scrapedDealerLeads.business_type,
products_sold: scrapedDealerLeads.products_sold,
website: scrapedDealerLeads.website,
quality_score: scrapedDealerLeads.quality_score,
phone_valid: scrapedDealerLeads.phone_valid,
converted_lead_id: scrapedDealerLeads.converted_lead_id,
```

- [ ] **Step 2: Update run detail API similarly**

In `src/app/api/scraper/runs/[id]/route.ts`, add the same new columns to the leads select query.

- [ ] **Step 3: Verify build**

```bash
npx next build
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/scraper/leads/route.ts src/app/api/scraper/runs/[id]/route.ts
git commit -m "feat(scraper): return enriched fields and quality score from leads APIs"
```

---

### Task 15: Final Build Verification + Cleanup

- [ ] **Step 1: Full build check**

```bash
npx next build
```

Expected: Build succeeds with no new errors.

- [ ] **Step 2: Verify all new API routes exist**

```bash
ls -la src/app/api/scraper/queries/
ls -la src/app/api/scraper/queries/\[id\]/
ls -la src/app/api/scraper/schedule/
ls -la src/app/api/scraper/cron/
ls -la src/app/api/scraper/leads/\[id\]/convert/
ls -la src/app/api/scraper/leads/\[id\]/route.ts
```

- [ ] **Step 3: Verify all new components exist**

```bash
ls -la src/components/scraper/
```

Expected: QueryManager.tsx, ScheduleConfig.tsx, QualityScoreBadge.tsx alongside existing components.

- [ ] **Step 4: Final commit (if any cleanup needed)**

```bash
git add -A
git commit -m "chore(scraper): final cleanup for scraper improvements"
```
