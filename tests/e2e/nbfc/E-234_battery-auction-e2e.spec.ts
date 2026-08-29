/**
 * E-232 → E-234 — Battery Recovery & Auction, end to end.
 *
 * Drives one pallet of batteries from warehouse intake all the way to a
 * settled auction, across four authenticated actors and three surfaces:
 *
 *   seller (NBFC)  — API only. Intake, refurbishment, lot composition and
 *                    publish shipped as services + routes with NO screen, so
 *                    there is nothing to click. Uses the same triple-guarded
 *                    test bypass as every other NBFC spec (E-069/E-070).
 *   dealer A / B   — real browser sessions. Browsing, bidding, the standing
 *                    maximum and the proxy engine are all driven through the
 *                    dealer UI, because that is the only place they exist.
 *   admin          — real browser session on the Auction Control Centre.
 *
 * WHY channels ARE in_app ONLY
 *   `india` scope resolves to ~47 approved dealer accounts, and a good number
 *   of those carry real people's inboxes. Publishing with the email channel
 *   would send 47 genuine "new auction lot" emails every time this spec runs.
 *   In-app proves the same fan-out mechanism — the audience is frozen, drained
 *   by the ticker, and every row reaches a terminal state — without mailing
 *   anybody.
 *
 * WHY THE DEADLINE IS NUDGED IN SQL
 *   The shortest legal window is 2 hours and the anti-snipe guard only fires in
 *   the final 120 s. There is no product action that lands a lot inside that
 *   window (admin "−15m" would need eight clicks), so the spec moves `ends_at`
 *   directly — scoped to its own lot by id. Same technique, same reason, as
 *   scripts/verify-auction-e2e.ts.
 *
 * Run:
 *   npx playwright test tests/e2e/nbfc/E-234_battery-auction-e2e.spec.ts --project=chromium
 *
 * Needs, in .env.test.local:
 *   E2E_BASE_URL, DATABASE_URL, NBFC_TEST_BYPASS_SECRET
 *   and the same secret exported to the server process.
 */
import { randomUUID } from 'node:crypto';
import { test, expect, type Page, type Browser, type APIRequestContext } from '@playwright/test';
import postgres from 'postgres';

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) throw new Error('DATABASE_URL must be set in .env.test.local');
const sql = postgres(DB_URL, { ssl: { rejectUnauthorized: false }, prepare: false });

const BYPASS = process.env.NBFC_TEST_BYPASS_SECRET ?? 'e082-loop-bypass-secret';

const RUN = randomUUID().slice(0, 6).toUpperCase();
const SERIALS = [`E2E234-${RUN}-A`, `E2E234-${RUN}-B`, `E2E234-${RUN}-C`];

const CREDS = {
  dealerA: {
    email: process.env.E2E_AUCTION_DEALER_A_EMAIL ?? 'buyback.dealer@itarang.com',
    password: process.env.E2E_AUCTION_DEALER_A_PASSWORD ?? 'password',
  },
  dealerB: {
    email: process.env.E2E_DEALER_EMAIL ?? 'dealer@itarang.com',
    password: process.env.E2E_DEALER_PASSWORD ?? 'password',
  },
  admin: {
    email: process.env.E2E_AUCTION_ADMIN_EMAIL ?? 'buyback.admin@itarang.com',
    password: process.env.E2E_AUCTION_ADMIN_PASSWORD ?? 'password',
  },
};

const BASE_PRICE = 150_000;
const INCREMENT = 2_000;

// ---------------------------------------------------------------------------
// Shared state across the serial chain
// ---------------------------------------------------------------------------
type Battery = { id: string; serial: string; state_code: string };

const ctx: {
  tenantId: string;
  sellerUserId: string;
  dealerAId: string;
  dealerBId: string;
  seller: APIRequestContext;
  batteries: Battery[];
  lotId: string;
  lotCode: string;
  extraLotIds: string[];
  pageA: Page;
  pageB: Page;
  pageAdmin: Page;
} = {
  tenantId: '',
  sellerUserId: '',
  dealerAId: '',
  dealerBId: '',
  seller: null as unknown as APIRequestContext,
  batteries: [],
  lotId: '',
  lotCode: '',
  extraLotIds: [],
  pageA: null as unknown as Page,
  pageB: null as unknown as Page,
  pageAdmin: null as unknown as Page,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function login(browser: Browser, email: string, password: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  // force: the login page's decorative artwork intercepts the hit-test.
  await page.getByRole('button', { name: /sign in/i }).click({ force: true });
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 45_000 });
  await expect(page, `${email} landed on change-password`).not.toHaveURL(/\/change-password/);
  return page;
}

/** One scheduler tick, driven from outside the process. */
async function tick(api: APIRequestContext): Promise<Record<string, unknown>> {
  const res = await api.post('/api/cron/auction/tick');
  expect(res.status(), 'cron tick').toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function lotRow(): Promise<Record<string, unknown>> {
  const r = await sql`SELECT * FROM auction_lots WHERE id = ${ctx.lotId}::uuid`;
  return r[0] as Record<string, unknown>;
}

async function topBid(): Promise<{ amount: number; bidder_dealer_id: string } | null> {
  const r = await sql`
    SELECT amount::float8 AS amount, bidder_dealer_id
      FROM auction_bids WHERE lot_id = ${ctx.lotId}::uuid
     ORDER BY amount DESC, placed_at ASC LIMIT 1`;
  return (r[0] as { amount: number; bidder_dealer_id: string } | undefined) ?? null;
}

async function bidCount(): Promise<number> {
  const r = await sql`SELECT count(*)::int AS c FROM auction_bids WHERE lot_id = ${ctx.lotId}::uuid`;
  return (r[0] as { c: number }).c;
}

/** Admin Control Centre: open a lot's action drawer, with the reason filled. */
async function openManage(page: Page, lotCode: string, reason: string) {
  const row = page.getByRole('row').filter({ hasText: lotCode }).first();
  await expect(row, `lot ${lotCode} visible in the Control Centre`).toBeVisible({ timeout: 20_000 });
  const manage = row.getByRole('button', { name: 'Manage' });
  if (await manage.isVisible()) await manage.click();
  const reasonBox = page.locator('input[id^="reason-"]').first();
  await expect(reasonBox).toBeVisible();
  await reasonBox.fill(reason);
}

async function cleanup() {
  const ids = [ctx.lotId, ...ctx.extraLotIds].filter(Boolean);
  for (const id of ids) {
    await sql`DELETE FROM auction_lot_audience   WHERE lot_id = ${id}::uuid`;
    await sql`DELETE FROM auction_lot_visibility WHERE lot_id = ${id}::uuid`;
    await sql`DELETE FROM auction_lot_items      WHERE lot_id = ${id}::uuid`;
    await sql`DELETE FROM auction_auto_bids      WHERE lot_id = ${id}::uuid`;
    await sql`DELETE FROM auction_bids           WHERE lot_id = ${id}::uuid`;
    await sql`DELETE FROM auction_settlements    WHERE lot_id = ${id}::uuid`;
    await sql`DELETE FROM nbfc_auction_cancel_requests WHERE lot_id = ${id}::uuid`;
    await sql`DELETE FROM nbfc_auction_lot_actions     WHERE lot_id = ${id}::uuid`;
    await sql`DELETE FROM notifications WHERE data->>'lot_id' = ${id}`;
    await sql`DELETE FROM auction_lots WHERE id = ${id}::uuid`;
  }
  await sql`DELETE FROM refurbishment_jobs WHERE battery_id IN
              (SELECT id FROM recovery_batteries WHERE serial LIKE ${'E2E234-' + RUN + '%'})`;
  await sql`DELETE FROM recovery_batteries WHERE serial LIKE ${'E2E234-' + RUN + '%'}`;
}

// ---------------------------------------------------------------------------

test.describe.configure({ mode: 'serial' });

test.describe('E-234 battery auction — end to end', () => {
  test.beforeAll(async ({ browser, playwright, baseURL }) => {
    // Seller tenant + a real user id (the audit rows FK onto users).
    const t = await sql`
      SELECT nu.tenant_id, nu.user_id
        FROM nbfc_users nu
        JOIN nbfc_tenants nt ON nt.id = nu.tenant_id
       WHERE nt.slug = 'demo-nbfc' LIMIT 1`;
    expect(t.length, 'a demo-nbfc tenant with a user must exist').toBe(1);
    ctx.tenantId = String((t[0] as { tenant_id: string }).tenant_id);
    ctx.sellerUserId = String((t[0] as { user_id: string }).user_id);

    ctx.seller = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: {
        'x-nbfc-test-bypass': BYPASS,
        'x-nbfc-test-tenant-id': ctx.tenantId,
        'x-nbfc-test-user-id': ctx.sellerUserId,
        'x-nbfc-test-user-role': 'nbfc_admin',
      },
    });

    // Fail loudly and early if the server was started without the bypass —
    // otherwise every seller step 401s and reads like a product bug.
    const probe = await ctx.seller.get('/api/nbfc/recovery/batteries?state=all');
    expect(
      probe.status(),
      'seller bypass rejected — is NBFC_TEST_BYPASS_SECRET set in the SERVER process too?',
    ).toBe(200);

    await cleanup();

    ctx.pageA = await login(browser, CREDS.dealerA.email, CREDS.dealerA.password);
    ctx.pageB = await login(browser, CREDS.dealerB.email, CREDS.dealerB.password);
    ctx.pageAdmin = await login(browser, CREDS.admin.email, CREDS.admin.password);

    const a = await sql`SELECT dealer_id FROM users WHERE lower(email) = ${CREDS.dealerA.email.toLowerCase()} AND is_active LIMIT 1`;
    const b = await sql`SELECT dealer_id FROM users WHERE lower(email) = ${CREDS.dealerB.email.toLowerCase()} AND is_active LIMIT 1`;
    ctx.dealerAId = String((a[0] as { dealer_id: string }).dealer_id);
    ctx.dealerBId = String((b[0] as { dealer_id: string }).dealer_id);
    expect(ctx.dealerAId, 'dealer A must be linked to an account').toBeTruthy();
    expect(ctx.dealerBId, 'dealer B must be linked to an account').toBeTruthy();
    expect(ctx.dealerAId, 'the two dealers must be different accounts').not.toBe(ctx.dealerBId);
  });

  test.afterAll(async () => {
    await cleanup().catch(() => {});
    await sql.end({ timeout: 5 }).catch(() => {});
  });

  // -------------------------------------------------------------------------
  test('01 · seller registers three recovered batteries', async () => {
    for (const serial of SERIALS) {
      const res = await ctx.seller.post('/api/nbfc/recovery/batteries', {
        data: {
          serial,
          model: 'E2E-48V-32Ah',
          capacity: '48V/32Ah',
          city: 'Nashik',
          state: 'Maharashtra',
          warehouse: 'Nashik collection centre',
        },
      });
      expect(res.status(), `intake ${serial}`).toBe(201);
      const body = await res.json();
      expect(body.battery.state_code).toBe('intaken');
      ctx.batteries.push(body.battery);
    }
    expect(ctx.batteries).toHaveLength(3);
  });

  test('02 · refurbishment carries two of them to "ready"', async () => {
    for (const battery of ctx.batteries.slice(0, 2)) {
      const created = await ctx.seller.post('/api/nbfc/recovery/refurbishment', {
        data: { battery_id: battery.id, assigned_workshop: 'E2E workshop', estimated_cost: 2500 },
      });
      expect(created.status(), `open a job on ${battery.serial}`).toBe(201);
      const job = (await created.json()).job;

      // BRD §15 — charger, harness and SOC meter must be new on every
      // refurbished battery, so the job pre-fills them rather than trusting a
      // form to remember.
      const keys = (job.accessories as { key: string }[]).map((x) => x.key).sort();
      expect(keys).toEqual(['charger', 'harness', 'soc_meter']);
      expect(job.total_cost, 'labour + the three accessories').toBe(2500 + 3500 + 2200 + 1800);

      const started = await ctx.seller.patch(`/api/nbfc/recovery/refurbishment/${job.id}`, {
        data: { status: 'in_progress' },
      });
      expect(started.status()).toBe(200);
      const returned = await ctx.seller.patch(`/api/nbfc/recovery/refurbishment/${job.id}`, {
        data: { status: 'returned', actual_cost: 2800 },
      });
      expect(returned.status()).toBe(200);

      // returned is terminal
      const again = await ctx.seller.patch(`/api/nbfc/recovery/refurbishment/${job.id}`, {
        data: { status: 'cancelled' },
      });
      expect(again.status(), 'a returned job cannot be cancelled').toBe(400);
      expect(await again.text()).toMatch(/invalid refurbishment transition returned -> cancelled/i);
    }

    const rows = await sql`
      SELECT serial, state_code, condition_grade FROM recovery_batteries
       WHERE serial = ANY(${SERIALS}) ORDER BY serial`;
    expect(rows.map((r) => (r as { state_code: string }).state_code)).toEqual([
      'ready',
      'ready',
      'intaken',
    ]);
    expect((rows[0] as { condition_grade: string }).condition_grade).toBe('refurbished');
  });

  test('03 · a lot refuses stock that has not been inspected', async () => {
    const res = await ctx.seller.post('/api/nbfc/auction/lots', {
      data: { battery_ids: [ctx.batteries[2].id], base_price: 40_000 },
    });
    expect(res.status()).toBe(409);
    expect(await res.text()).toMatch(/only inspected or ready batteries/i);
  });

  test('04 · compose a two-battery draft lot', async () => {
    const res = await ctx.seller.post('/api/nbfc/auction/lots', {
      data: {
        battery_ids: [ctx.batteries[0].id, ctx.batteries[1].id],
        title: `E2E ${RUN} — 2 × 48V/32Ah refurbished`,
        auction_type: 'cash',
        base_price: BASE_PRICE,
        bid_increment: INCREMENT,
        anti_snipe_seconds: 120,
      },
    });
    expect(res.status()).toBe(201);
    const lot = (await res.json()).lot;
    ctx.lotId = lot.lot_id;
    ctx.lotCode = lot.lot_code;

    expect(lot.status, 'composing must NOT publish').toBe('draft');
    expect(lot.quantity, 'multi-battery lot').toBe(2);

    const items = await sql`SELECT count(*)::int AS c FROM auction_lot_items WHERE lot_id = ${ctx.lotId}::uuid`;
    expect((items[0] as { c: number }).c).toBe(2);

    const states = await sql`
      SELECT state_code FROM recovery_batteries WHERE id = ANY(${[ctx.batteries[0].id, ctx.batteries[1].id]}::uuid[])`;
    expect(states.every((r) => (r as { state_code: string }).state_code === 'lotted')).toBe(true);
  });

  test('05 · the same battery cannot be sold twice at once', async () => {
    const res = await ctx.seller.post('/api/nbfc/auction/lots', {
      data: { battery_ids: [ctx.batteries[0].id], base_price: 10_000 },
    });
    expect(res.status()).toBe(409);
    expect(await res.text()).toMatch(/already in an open lot|is lotted/i);
  });

  test('06 · publish enforces the four legal windows', async () => {
    const res = await ctx.seller.post(`/api/nbfc/auction/lots/${ctx.lotId}/publish`, {
      data: { duration_hours: 72, visibility: { scope: 'india' } },
    });
    expect(res.status()).toBe(400);
    const lot = await lotRow();
    expect(lot.status, 'a rejected publish must leave the lot in draft').toBe('draft');
  });

  test('07 · publish freezes an audience and goes live', async () => {
    const res = await ctx.seller.post(`/api/nbfc/auction/lots/${ctx.lotId}/publish`, {
      data: {
        duration_hours: 2,
        visibility: { scope: 'india' },
        // in_app only — see the header note on not emailing 47 real dealers.
        channels: ['in_app'],
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('live');
    expect(body.audience_dealers, 'india scope resolves real dealers').toBeGreaterThan(1);
    expect(body.audience_rows).toBe(body.audience_dealers);

    const frozen = await sql`
      SELECT count(*)::int AS c FROM auction_lot_audience WHERE lot_id = ${ctx.lotId}::uuid`;
    expect((frozen[0] as { c: number }).c).toBe(body.audience_rows);

    // Both test dealers must be inside it, or the bidding phase is untestable.
    const mine = await sql`
      SELECT dealer_id FROM auction_lot_audience
       WHERE lot_id = ${ctx.lotId}::uuid AND dealer_id = ANY(${[ctx.dealerAId, ctx.dealerBId]})`;
    expect(mine.length, 'both dealers in the frozen audience').toBe(2);

    const dup = await ctx.seller.post(`/api/nbfc/auction/lots/${ctx.lotId}/publish`, {
      data: { duration_hours: 2, visibility: { scope: 'india' } },
    });
    expect(dup.status(), 'publishing twice').toBe(409);
  });

  test('08 · the ticker drains the announcement to a terminal state', async () => {
    await tick(ctx.seller);
    await expect
      .poll(
        async () => {
          const r = await sql`
            SELECT count(*)::int AS c FROM auction_lot_audience
             WHERE lot_id = ${ctx.lotId}::uuid AND status = 'pending'`;
          return (r[0] as { c: number }).c;
        },
        { timeout: 45_000, intervals: [1_000], message: 'audience rows left pending' },
      )
      .toBe(0);

    const byStatus = await sql`
      SELECT status, count(*)::int AS c FROM auction_lot_audience
       WHERE lot_id = ${ctx.lotId}::uuid GROUP BY status`;
    const sent = byStatus.find((r) => (r as { status: string }).status === 'sent') as
      | { c: number }
      | undefined;
    expect(sent?.c ?? 0, 'dealers with a login get a bell row').toBeGreaterThan(0);

    // A row marked `sent` must correspond to a notification that really exists.
    const bells = await sql`
      SELECT count(DISTINCT dealer_id)::int AS c FROM notifications
       WHERE type = 'auction.lot_published' AND data->>'lot_id' = ${ctx.lotId}`;
    expect((bells[0] as { c: number }).c, 'no phantom sends').toBe(sent?.c ?? 0);
  });

  // -------------------------------------------------------------------------
  test('09 · dealer A finds the lot in the auction browser', async () => {
    const page = ctx.pageA;
    await page.goto('/dealer-portal/auctions');
    await expect(page.getByRole('heading', { name: 'Battery auctions' })).toBeVisible();
    const card = page.locator('.auc-card').filter({ hasText: ctx.lotCode });
    await expect(card, `${ctx.lotCode} visible to dealer A`).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('refurbished');
    await expect(card).toContainText('2');
  });

  test('10 · a bid below the minimum is refused and inserts nothing', async () => {
    const page = ctx.pageA;
    await page.goto(`/dealer-portal/auctions/${ctx.lotId}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });

    const amount = page.locator('#bid-amount');
    await expect(amount).toHaveValue(String(BASE_PRICE));

    // The button guards the obvious case, so go around it the way a hand-rolled
    // request would: the server must refuse on its own.
    const res = await page.request.post(`/api/dealer/auctions/${ctx.lotId}/bid`, {
      data: { amount: 100, confirmed: true },
    });
    const json = await res.json();
    expect(json.data?.accepted, 'below-base bid').toBe(false);
    expect(json.data?.min_next_bid).toBe(BASE_PRICE);
    expect(await bidCount(), 'a rejected bid must not be stored').toBe(0);
  });

  test('11 · dealer A opens the bidding at the base price', async () => {
    const page = ctx.pageA;
    await page.reload();
    const amount = page.locator('#bid-amount');
    await expect(amount).toHaveValue(String(BASE_PRICE));
    await page.getByRole('button', { name: 'Place bid' }).click();

    await expect(page.getByText(/Bid placed at/i)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('you lead')).toBeVisible({ timeout: 10_000 });

    const top = await topBid();
    expect(top?.amount).toBe(BASE_PRICE);
    expect(top?.bidder_dealer_id).toBe(ctx.dealerAId);
  });

  test('12 · dealer B leaves a standing maximum', async () => {
    const page = ctx.pageB;
    await page.goto(`/dealer-portal/auctions/${ctx.lotId}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });

    await page.getByLabel('Standing maximum').fill('200000');
    await page.getByRole('button', { name: 'Set', exact: true }).click();
    await expect(page.getByText(/Standing maximum set at/i)).toBeVisible({ timeout: 10_000 });

    const rows = await sql`
      SELECT max_amount::float8 AS max_amount, bidder_dealer_id FROM auction_auto_bids
       WHERE lot_id = ${ctx.lotId}::uuid`;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { max_amount: number }).max_amount).toBe(200_000);
    expect((rows[0] as { bidder_dealer_id: string }).bidder_dealer_id).toBe(ctx.dealerBId);

    // Setting a maximum must not itself bid.
    expect(await bidCount(), 'a standing order is not a bid').toBe(1);
  });

  test('13 · the proxy answers with one increment, not the ceiling', async () => {
    const page = ctx.pageA;
    await page.goto(`/dealer-portal/auctions/${ctx.lotId}`);
    const amount = page.locator('#bid-amount');
    await amount.fill('160000');
    await page.getByRole('button', { name: 'Place bid' }).click();

    await expect
      .poll(async () => (await topBid())?.amount, { timeout: 20_000, intervals: [500] })
      .toBe(162_000);

    const top = await topBid();
    expect(top?.bidder_dealer_id, 'dealer B now leads through their proxy').toBe(ctx.dealerBId);
    expect(top?.amount, 'one increment over 160000, NOT the 200000 ceiling').toBe(
      160_000 + INCREMENT,
    );

    // Dealer A is told they are already losing, not congratulated.
    await expect(page.getByText(/standing maximum immediately went to/i)).toBeVisible({
      timeout: 10_000,
    });

    const outbid = await sql`
      SELECT count(*)::int AS c FROM notifications
       WHERE type = 'auction.outbid' AND data->>'lot_id' = ${ctx.lotId}`;
    expect((outbid[0] as { c: number }).c, 'outbid notification fired').toBeGreaterThan(0);
  });

  test('14 · a proxy never bids against its own owner', async () => {
    const before = await bidCount();
    const res = await ctx.pageB.request.post(`/api/dealer/auctions/${ctx.lotId}/bid`, {
      data: { amount: 164_000, confirmed: true },
    });
    const json = await res.json();
    expect(json.data?.accepted).toBe(true);
    expect(json.data?.outbid_by_proxy, "dealer B's own standing order must stay quiet").toBeFalsy();
    expect(await bidCount(), 'exactly one new bid').toBe(before + 1);
  });

  test('15 · no bidder identity ever reaches the wire (BRD §11)', async () => {
    const res = await ctx.pageA.request.get(`/api/dealer/auctions/${ctx.lotId}`);
    expect(res.status()).toBe(200);
    const raw = await res.text();

    expect(raw, 'the rival account id must not be in the payload').not.toContain(ctx.dealerBId);
    expect(raw.toLowerCase()).not.toContain('bidder_name');
    expect(raw).not.toContain(CREDS.dealerB.email);

    const body = JSON.parse(raw);
    expect(body.data.current_bid, 'the price IS public').toBe(164_000);
    expect(body.data.you_are_leading, 'computed server-side for the caller').toBe(false);
  });

  test('16 · a late bid extends the deadline (anti-snipe)', async () => {
    // The guarantee the engine actually makes is "at least one full anti-snipe
    // window of quiet after the last bid" — it sets ends_at = now + window,
    // it does not ADD the window to whatever was left. Both the code comment
    // in service.ts and the dealer-facing copy on the lot page say "extends the
    // auction by the same amount", which is only true when the clock has
    // already run out. Asserted as the invariant that matters; the wording
    // mismatch is reported separately.
    const WINDOW_MS = 120_000;
    await sql`UPDATE auction_lots SET ends_at = now() + interval '60 seconds' WHERE id = ${ctx.lotId}::uuid`;
    const before = new Date(String((await lotRow()).ends_at)).getTime();

    const res = await ctx.pageA.request.post(`/api/dealer/auctions/${ctx.lotId}/bid`, {
      data: { amount: 170_000, confirmed: true },
    });
    const json = await res.json();
    expect(json.data?.accepted).toBe(true);
    expect(json.data?.extended, 'flagged as an anti-snipe extension').toBe(true);

    // Dealer B's ₹2,00,000 standing order is still live, so it answers this bid
    // too — one increment over, same as before. B stays in front at ₹1,72,000,
    // which is who test 21 expects to win.
    expect(json.data?.outbid_by_proxy, "B's standing order answers again").toBe(172_000);
    const leader = await topBid();
    expect(leader?.bidder_dealer_id).toBe(ctx.dealerBId);
    expect(leader?.amount).toBe(172_000);

    const after = new Date(String((await lotRow()).ends_at)).getTime();
    expect(after, 'the deadline moved out').toBeGreaterThan(before);
    expect(
      after - Date.now(),
      `only ${Math.round((after - Date.now()) / 1000)}s of quiet left after a last-second bid`,
    ).toBeGreaterThan(WINDOW_MS - 15_000);
  });

  // -------------------------------------------------------------------------
  test('17 · admin sees the lot and every action is reason-gated', async () => {
    const page = ctx.pageAdmin;
    await page.goto('/admin/nbfc/auction');
    await expect(page.getByRole('heading', { name: 'Auction Control Centre' })).toBeVisible({
      timeout: 30_000,
    });

    const row = page.getByRole('row').filter({ hasText: ctx.lotCode }).first();
    await expect(row, 'the live lot is listed').toBeVisible({ timeout: 20_000 });
    await row.getByRole('button', { name: 'Manage' }).click();

    // With no reason typed, the timing controls stay disabled.
    await expect(page.getByRole('button', { name: '+15m' })).toBeDisabled();
    await page.locator('input[id^="reason-"]').first().fill('E2E — timing check');
    await expect(page.getByRole('button', { name: '+15m' })).toBeEnabled();
  });

  test('18 · admin extends the auction by 15 minutes', async () => {
    const page = ctx.pageAdmin;
    const before = new Date(String((await lotRow()).ends_at)).getTime();
    await openManage(page, ctx.lotCode, 'E2E — extend by 15');
    await page.getByRole('button', { name: '+15m' }).click();

    await expect
      .poll(async () => new Date(String((await lotRow()).ends_at)).getTime() - before, {
        timeout: 20_000,
        intervals: [500],
      })
      .toBeGreaterThan(14 * 60_000);
  });

  test('19 · pause stops bidding, resume gives the time back', async () => {
    const page = ctx.pageAdmin;
    await openManage(page, ctx.lotCode, 'E2E — pause');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();

    await expect
      .poll(async () => String((await lotRow()).status), { timeout: 20_000, intervals: [500] })
      .toBe('paused');

    // A paused lot must refuse bids.
    const blocked = await ctx.pageA.request.post(`/api/dealer/auctions/${ctx.lotId}/bid`, {
      data: { amount: 180_000, confirmed: true },
    });
    expect(blocked.ok(), 'bidding on a paused lot').toBeFalsy();

    // ...and drop out of the dealer's live list.
    await ctx.pageA.goto('/dealer-portal/auctions');
    await expect(
      ctx.pageA.locator('.auc-card').filter({ hasText: ctx.lotCode }),
    ).toHaveCount(0, { timeout: 20_000 });

    // A paused lot also leaves the admin's default "Live" tab — resuming means
    // going to find it under Paused.
    await page.reload();
    await page.getByRole('tab', { name: 'Paused' }).click();
    await openManage(page, ctx.lotCode, 'E2E — resume');
    await page.getByRole('button', { name: 'Resume' }).click();
    await expect
      .poll(async () => String((await lotRow()).status), { timeout: 20_000, intervals: [500] })
      .toBe('live');
  });

  test('20 · the destructive actions are locked behind the MFA field', async () => {
    const page = ctx.pageAdmin;
    await page.reload();
    await openManage(page, ctx.lotCode, 'E2E — mfa gate');
    await page.getByLabel('Show the actions that end this auction early').check();

    // Below 6 characters the destructive buttons stay locked.
    const mfa = page.locator('input[id^="mfa-"]').first();
    await mfa.fill('123');
    await expect(page.getByRole('button', { name: 'End now' })).toBeDisabled();
    await expect(page.getByRole('button', { name: '−15m' })).toBeDisabled();

    await mfa.fill('654321');
    await expect(page.getByRole('button', { name: 'End now' })).toBeEnabled();
    await expect(page.getByRole('button', { name: '−15m' })).toBeEnabled();
    // Deliberately NOT clicked here — "End now" never reaches the settlement
    // path, which test 26 pins down on a lot of its own.
  });

  test('21 · the scheduler closes the lot and books the settlement', async () => {
    // Let the window expire naturally. This is the path the closer is built
    // for: it claims lots that are still `live` and past their deadline.
    await sql`UPDATE auction_lots SET ends_at = now() - interval '1 second' WHERE id = ${ctx.lotId}::uuid`;
    await tick(ctx.seller);

    await expect
      .poll(async () => String((await lotRow()).status), { timeout: 45_000, intervals: [1_000] })
      .toBe('ended');

    const settle = await sql`
      SELECT seller_tenant_id, winner_dealer_id, final_price::float8 AS final_price, status
        FROM auction_settlements WHERE lot_id = ${ctx.lotId}::uuid`;
    expect(settle, 'a closed lot with bids must produce a settlement').toHaveLength(1);
    const s = settle[0] as {
      seller_tenant_id: string;
      winner_dealer_id: string;
      final_price: number;
    };
    expect(s.seller_tenant_id, 'not the zero-uuid sentinel').toBe(ctx.tenantId);
    // Dealer B wins through their proxy — they never typed 172,000, and they
    // pay what it took to beat A rather than their 200,000 ceiling.
    expect(s.winner_dealer_id, 'dealer B held the top bid').toBe(ctx.dealerBId);
    expect(s.final_price, 'the price is what it took to win, not the ceiling').toBe(172_000);

    const sold = await sql`
      SELECT count(*)::int AS c FROM recovery_batteries
       WHERE id = ANY(${[ctx.batteries[0].id, ctx.batteries[1].id]}::uuid[]) AND state_code = 'sold'`;
    expect((sold[0] as { c: number }).c, 'both batteries marked sold').toBe(2);

    const won = await sql`
      SELECT count(*)::int AS c FROM notifications
       WHERE type = 'auction.won' AND data->>'lot_id' = ${ctx.lotId}`;
    expect((won[0] as { c: number }).c, 'the winner is told').toBeGreaterThan(0);
  });

  test('22 · a second tick does not re-close or double-settle', async () => {
    await tick(ctx.seller);
    const settle = await sql`
      SELECT count(*)::int AS c FROM auction_settlements WHERE lot_id = ${ctx.lotId}::uuid`;
    expect((settle[0] as { c: number }).c, 'exactly one settlement').toBe(1);
  });

  test('23 · admin approves the winning bid', async () => {
    const page = ctx.pageAdmin;
    await page.goto('/admin/nbfc/auction');
    await page.getByRole('tab', { name: 'Ended' }).click().catch(async () => {
      await page.getByRole('button', { name: 'Ended' }).click();
    });
    await openManage(page, ctx.lotCode, 'E2E — award');
    await page.getByRole('button', { name: /Approve .* winner/ }).click();

    await expect
      .poll(
        async () => {
          const r = await sql`
            SELECT status FROM auction_settlements WHERE lot_id = ${ctx.lotId}::uuid`;
          return String((r[0] as { status: string })?.status);
        },
        { timeout: 20_000, intervals: [500] },
      )
      .toMatch(/payment_pending|pending/);
  });

  // -------------------------------------------------------------------------
  test('24 · NBFCs are structurally barred from bidding (BRD §9)', async () => {
    const res = await ctx.seller.post(`/api/nbfc/auction/lots/${ctx.lotId}/bid`, {
      data: { amount: 500_000, confirmed: true },
    });
    expect(res.status()).toBe(403);
    expect(await res.text()).toMatch(/dealers only/i);
  });

  test('25 · a dealer outside the frozen audience cannot see or reach the lot', async () => {
    // Dealer A is in Nashik; dealer B has no city, so a city-scoped lot must
    // reach A and nobody else.
    const composed = await ctx.seller.post('/api/nbfc/auction/lots', {
      data: {
        battery_ids: [ctx.batteries[2].id],
        title: `E2E ${RUN} — Nashik only`,
        base_price: 40_000,
      },
    });
    // battery 3 is still `intaken`; take it to ready the short way first.
    if (composed.status() !== 201) {
      const job = (
        await (
          await ctx.seller.post('/api/nbfc/recovery/refurbishment', {
            data: { battery_id: ctx.batteries[2].id, estimated_cost: 0 },
          })
        ).json()
      ).job;
      await ctx.seller.patch(`/api/nbfc/recovery/refurbishment/${job.id}`, {
        data: { status: 'in_progress' },
      });
      await ctx.seller.patch(`/api/nbfc/recovery/refurbishment/${job.id}`, {
        data: { status: 'returned' },
      });
    }
    const retry = await ctx.seller.post('/api/nbfc/auction/lots', {
      data: {
        battery_ids: [ctx.batteries[2].id],
        title: `E2E ${RUN} — Nashik only`,
        base_price: 40_000,
      },
    });
    expect(retry.status()).toBe(201);
    const lot2 = (await retry.json()).lot;
    ctx.extraLotIds.push(lot2.lot_id);

    const pub = await ctx.seller.post(`/api/nbfc/auction/lots/${lot2.lot_id}/publish`, {
      data: {
        duration_hours: 2,
        visibility: { scope: 'city', cities: ['Nashik'] },
        channels: ['in_app'],
      },
    });
    expect(pub.status()).toBe(200);

    const aud = await sql`
      SELECT dealer_id FROM auction_lot_audience WHERE lot_id = ${lot2.lot_id}::uuid`;
    const ids = aud.map((r) => String((r as { dealer_id: string }).dealer_id));
    expect(ids, 'the Nashik dealer is in').toContain(ctx.dealerAId);
    expect(ids, 'the city-less dealer is out').not.toContain(ctx.dealerBId);

    // The API is the gate, not the component.
    const denied = await ctx.pageB.request.get(`/api/dealer/auctions/${lot2.lot_id}`);
    expect(denied.status(), 'out-of-audience dealer reading a lot by id').toBe(404);

    await ctx.pageB.goto(`/dealer-portal/auctions/${lot2.lot_id}`);
    await expect(ctx.pageB.getByText('Lot unavailable')).toBeVisible({ timeout: 20_000 });

    await ctx.pageA.goto(`/dealer-portal/auctions/${lot2.lot_id}`);
    await expect(ctx.pageA.getByRole('heading', { level: 1 })).toContainText('Nashik only', {
      timeout: 20_000,
    });
  });

  // ---------------------------------------------------------------------------
  // REGRESSION — admin "End now" must settle the sale.
  //
  // `reduceTime({end_now: true})` used to write `auction_lots.status = 'ended'`
  // itself. The closer only ever claims lots `WHERE status = 'live' AND ends_at
  // <= now()`, so a lot ended this way was never claimed: no winner picked, no
  // auction_settlements row, no close audit, and the batteries stranded at
  // `lotted` — neither sold nor released for re-listing. The sale was agreed
  // and nothing recorded it.
  //
  // The loud "closed with a winning bid but NO settlement" guard in
  // instrumentation-node.ts could not catch it either: that guard iterates the
  // closer's OWN result list, which such a lot never entered.
  //
  // reduceTime now moves `ends_at` only and calls closeLotNow(), so an early
  // end is indistinguishable from a natural one downstream.
  // ---------------------------------------------------------------------------
  test('26 · admin "End now" closes AND settles, in one action', async () => {
    const lot2Id = ctx.extraLotIds[0];
    expect(lot2Id, 'test 25 must have published the second lot').toBeTruthy();

    const lot2 = (await sql`SELECT lot_code FROM auction_lots WHERE id = ${lot2Id}::uuid`)[0] as {
      lot_code: string;
    };

    // Dealer A is in this lot's audience — give it a real winning bid so the
    // sale is unambiguous.
    const bid = await ctx.pageA.request.post(`/api/dealer/auctions/${lot2Id}/bid`, {
      data: { amount: 40_000, confirmed: true },
    });
    expect((await bid.json()).data?.accepted, 'dealer A bids on the Nashik lot').toBe(true);

    // Admin ends it early through the Control Centre.
    const page = ctx.pageAdmin;
    page.once('dialog', (d) => void d.accept());
    await page.goto('/admin/nbfc/auction');
    await openManage(page, lot2.lot_code, 'E2E — end now');
    await page.getByLabel('Show the actions that end this auction early').check();
    await page.locator('input[id^="mfa-"]').first().fill('654321');
    await page.getByRole('button', { name: 'End now' }).click();

    await expect
      .poll(
        async () => {
          const r = await sql`SELECT status FROM auction_lots WHERE id = ${lot2Id}::uuid`;
          return String((r[0] as { status: string }).status);
        },
        { timeout: 20_000, intervals: [500] },
      )
      .toBe('ended');

    // Asserted BEFORE any tick: the close is part of the admin's action, not
    // something a scheduler pass tidies up 15 s later.
    const settle = await sql`
      SELECT winner_dealer_id, final_price::float8 AS final_price
        FROM auction_settlements WHERE lot_id = ${lot2Id}::uuid`;
    expect(settle, 'ending early still books the sale').toHaveLength(1);
    expect((settle[0] as { winner_dealer_id: string }).winner_dealer_id).toBe(ctx.dealerAId);
    expect((settle[0] as { final_price: number }).final_price).toBe(40_000);

    const state = await sql`
      SELECT state_code FROM recovery_batteries WHERE id = ${ctx.batteries[2].id}::uuid`;
    expect(
      String((state[0] as { state_code: string }).state_code),
      'the battery is sold, not stranded at "lotted"',
    ).toBe('sold');

    const closeAudit = await sql`
      SELECT reason FROM nbfc_auction_lot_actions
       WHERE lot_id = ${lot2Id}::uuid AND action_code = 'scheduler_close'`;
    expect(closeAudit, 'the close is on the audit trail').toHaveLength(1);
    expect(String((closeAudit[0] as { reason: string }).reason)).toMatch(/ended early/i);

    // And the closer must not take it a second time.
    await tick(ctx.seller);
    const again = await sql`
      SELECT count(*)::int AS c FROM auction_settlements WHERE lot_id = ${lot2Id}::uuid`;
    expect((again[0] as { c: number }).c, 'no double settlement').toBe(1);
  });
});
