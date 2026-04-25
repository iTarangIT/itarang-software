/**
 * Dealer-lead inputs used by leads/creation specs.
 * Phone is scoped per worker/test to avoid DB UNIQUE collisions.
 */

export type DealerLeadInput = {
  dealerName: string;
  phone: string;
  shopName: string;
  location: string;
  language: 'hindi' | 'hinglish' | 'english';
  interest: 'hot' | 'warm' | 'cold';
};

export function buildDealerLead(
  workerIndex: number,
  testId: string,
  overrides: Partial<DealerLeadInput> = {},
): DealerLeadInput {
  const suffix = String(900_000 + workerIndex * 100 + parseInt(testId.slice(-3), 36)).padStart(6, '0');
  return {
    dealerName: `E2E Dealer ${testId.slice(-6)}`,
    phone: `+91999${suffix}`,
    shopName: 'E2E Battery Shop',
    location: 'Pune, Maharashtra',
    language: 'hinglish',
    interest: 'warm',
    ...overrides,
  };
}
