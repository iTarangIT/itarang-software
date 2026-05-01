import { test, expect } from '@playwright/test';

/**
 * E-004 — NBFC identity format validators.
 *
 * The route /api/admin/nbfc/validate-identity is admin-gated. These tests
 * use the route's documented test-bypass affordance (only honoured when
 * NODE_ENV !== 'production' and E2E_TEST_BYPASS_SECRET is set on the
 * server). The matching header value comes from the env file the loop
 * script loads before booting the dev server.
 */

const BYPASS_SECRET = process.env.E2E_TEST_BYPASS_SECRET ?? '';
const headers: Record<string, string> = BYPASS_SECRET
  ? { 'x-e2e-test-secret': BYPASS_SECRET }
  : {};

test.describe('E-004 — NBFC identity format validators', () => {
  test('AC1: valid RBI CoR pattern accepted', async ({ request }) => {
    const res = await request.post('/api/admin/nbfc/validate-identity', {
      data: { rbiRegistrationNo: 'N-12.34567.89.01.2345.67890.12' },
      headers,
    });
    expect(res.status(), `unexpected status ${res.status()} body=${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.errors.rbiRegistrationNo).toBeNull();
  });

  test('AC2: invalid RBI CoR pattern rejected', async ({ request }) => {
    const res = await request.post('/api/admin/nbfc/validate-identity', {
      data: { rbiRegistrationNo: 'N-1234567' },
      headers,
    });
    expect(res.status(), `unexpected status ${res.status()} body=${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors.rbiRegistrationNo).not.toBeNull();
    expect(typeof body.errors.rbiRegistrationNo).toBe('string');
  });

  test('AC3: lowercase PAN rejected', async ({ request }) => {
    const res = await request.post('/api/admin/nbfc/validate-identity', {
      data: { panNumber: 'abcde1234f' },
      headers,
    });
    expect(res.status(), `unexpected status ${res.status()} body=${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors.panNumber).not.toBeNull();
  });

  test('AC4: valid GST pattern accepted', async ({ request }) => {
    const res = await request.post('/api/admin/nbfc/validate-identity', {
      data: { gstNumber: '22AAAAA0000A1Z5' },
      headers,
    });
    expect(res.status(), `unexpected status ${res.status()} body=${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.errors.gstNumber).toBeNull();
  });
});
