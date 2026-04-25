/**
 * Per-test-unique dealer fixtures. GSTIN / PAN / email must be unique in the
 * DB (UNIQUE constraint on accounts.gstin), so each run derives values from
 * workerIndex + testId.
 */

export type DealerSeed = {
  companyName: string;
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  gstin: string;
  pan: string;
  runId: string;
};

export function buildDealerSeed(workerIndex: number, testId: string): DealerSeed {
  const hash = (testId.slice(-4) + workerIndex).replace(/[^a-zA-Z0-9]/g, '0').slice(-4).padEnd(4, '0');
  const runId = Date.now().toString().slice(-6);
  const letters = runId
    .split('')
    .map((d) => String.fromCharCode(65 + parseInt(d, 10)))
    .join('');
  return {
    companyName: `E2E Dealer ${letters}`,
    ownerName: `E2E Owner ${letters}`,
    ownerEmail: `e2e-dealer-${runId}-${hash}@itarang.test`,
    ownerPhone: `+91999${String(900_000 + workerIndex * 100 + parseInt(hash, 36) % 100).padStart(6, '0')}`,
    gstin: `27AAGCS${hash}F1Z5`,
    pan: `AAGCS${hash}F`,
    runId,
  };
}
