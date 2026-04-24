/**
 * Named preset Decentro response shapes. Captured once against Decentro sandbox
 * (2026-04-23) — refresh if Decentro changes their response envelope.
 *
 * These are used by helpers/api-stubs.ts to simulate success, failure,
 * mismatch, and other edge states without hitting the paid API.
 */

export const panPresets = {
  success: {
    status: 'SUCCESS',
    responseStatus: 'SUCCESS',
    kycResult: {
      idStatus: 'VALID',
      fullName: 'PLAYWRIGHT TEST USER',
      fatherName: 'TEST FATHER',
      category: 'INDIVIDUAL',
      panType: 'INDIVIDUAL',
    },
    decentroTxnId: 'stub-pan-success',
  },
  mismatch: {
    status: 'SUCCESS',
    responseStatus: 'SUCCESS',
    kycResult: {
      idStatus: 'VALID',
      fullName: 'COMPLETELY DIFFERENT NAME',
    },
    decentroTxnId: 'stub-pan-mismatch',
  },
  invalid: {
    status: 'FAILURE',
    responseStatus: 'FAILURE',
    kycResult: { idStatus: 'INVALID', fullName: '' },
    error: { message: 'PAN not found' },
    decentroTxnId: 'stub-pan-invalid',
  },
};

export const bankPresets = {
  success: {
    status: 'SUCCESS',
    kycResult: { accountName: 'Playwright Test User', nameMatch: true, idStatus: 'VALID' },
    decentroTxnId: 'stub-bank-success',
  },
  notFound: {
    status: 'FAILURE',
    kycResult: { idStatus: 'ACCOUNT_NOT_FOUND' },
    error: { message: 'Account not found for given IFSC + account number' },
    decentroTxnId: 'stub-bank-notfound',
  },
};

export const aadhaarPresets = {
  success: {
    status: 'document_fetched',
    aadhaarExtractedData: {
      name: 'Playwright Test User',
      uid: 'XXXXXXXX1234',
      dob: '01-01-1990',
      gender: 'M',
      address: '221B Test Street, Pune',
    },
  },
  cancelled: {
    status: 'cancelled',
    aadhaarExtractedData: null,
  },
};
