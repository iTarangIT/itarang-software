import { test, expect } from '@playwright/test';

/**
 * E-004 — NBFC identity format validators.
 *
 * The route /api/admin/nbfc/validate-identity is admin-gated. These tests
 * exercise it via the storageState-authenticated nbfc-ui browser context
 * by reusing its cookies for a request fixture. Since this is an API test
 * file (.api.spec.ts) it runs on the nbfc-api project which doesn't apply
 * a storageState. To make the tests work without the setup-project auth
 * dependency, we hit the endpoint directly and accept either a 200 result
 * (auth seeded) or surface a clear failure mode if we get 401 (auth infra
 * not yet wired in the loop).
 */

test.describe('E-004 — NBFC identity format validators', () => {
  test('AC1: valid RBI CoR pattern accepted', async ({ request }) => {
    const res = await request.post('/api/admin/nbfc/validate-identity', {
      data: { rbiRegistrationNo: 'N-12.34567.89.01.2345.67890.12' },
    });
    expect(res.status(), `unexpected status ${res.status()} body=${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.errors.rbiRegistrationNo).toBeNull();
  });

  test('AC2: invalid RBI CoR pattern rejected', async ({ request }) => {
    const res = await request.post('/api/admin/nbfc/validate-identity', {
      data: { rbiRegistrationNo: 'N-1234567' },
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
    });
    expect(res.status(), `unexpected status ${res.status()} body=${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors.panNumber).not.toBeNull();
  });

  test('AC4: valid GST pattern accepted', async ({ request }) => {
    const res = await request.post('/api/admin/nbfc/validate-identity', {
      data: { gstNumber: '22AAAAA0000A1Z5' },
    });
    expect(res.status(), `unexpected status ${res.status()} body=${await res.text()}`).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.errors.gstNumber).toBeNull();
  });
});
