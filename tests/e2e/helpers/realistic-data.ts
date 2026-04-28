/**
 * Realistic-looking dealer / lead data for prod and sandbox runs. Three sources:
 *
 *   1. Faker (en_IN locale) — names, dob, addresses, business names.
 *   2. India Post pincode API — turns a Faker-chosen pincode into a real
 *      city/district/state. https://api.postalpincode.in/pincode/<PIN>
 *   3. Razorpay IFSC API — turns a curated IFSC code into a real bank/branch.
 *      https://ifsc.razorpay.com/<IFSC>
 *
 * Identifiers (PAN, GST, Aadhaar) are generated to be format-valid only — never
 * scraped from real records. The hard rule: a real person's PAN must NEVER end
 * up in a Decentro request. See `assertNotRealIdentifier()`.
 *
 * Everything is keyed by runId so re-calling within one suite invocation gives
 * the same dealer the same name, pan, bank, etc. across wizard steps.
 */

import { faker as enInFaker, fakerEN_IN, Faker, en_IN, en } from '@faker-js/faker';
import { currentRunId, prodEmail, prodPhone, tagCompany, tagDealer } from './prod-namespace';
import { isProdRun } from './prod-guard';

// Some Faker properties are missing in en_IN; fall back to en where needed.
const faker = new Faker({ locale: [en_IN, en] });

// ---- module-level guard -----------------------------------------------------

if (process.env.E2E_BASE_URL && /crm\.itarang\.com/i.test(process.env.E2E_BASE_URL)) {
  if (process.env.E2E_ALLOW_PROD !== '1') {
    throw new Error(
      '[realistic-data] E2E_BASE_URL points at production but E2E_ALLOW_PROD is not set. Refusing to import.',
    );
  }
}

// ---- caches ----------------------------------------------------------------

type DealerProfile = {
  runId: string;
  // company
  companyName: string;
  companyType: 'sole_proprietorship' | 'partnership_firm' | 'private_limited_firm';
  companyAddressLine: string;
  pincode: string;
  city: string;
  district: string;
  state: string;
  businessSummary: string;
  // owner
  ownerName: string;
  ownerEmail: string;
  ownerPhone: string;
  ownerDob: string; // yyyy-mm-dd
  ownerAge: number;
  fatherOrHusbandName: string;
  // bank
  bankName: string;
  bankBranch: string;
  bankIfsc: string;
  bankAccountNumber: string;
  bankBeneficiary: string;
  // identifiers (synthetic, format-valid)
  pan: string;
  gstin: string;
  aadhaar: string;
  // vehicle
  vehicleRc: string;
};

type LeadProfile = {
  runId: string;
  fullName: string;
  fatherOrHusbandName: string;
  phone: string;
  email: string;
  dob: string;
  permanentAddress: string;
  pincode: string;
  city: string;
  state: string;
  pan: string;
  aadhaar: string;
  interestLevel: 'hot' | 'warm' | 'cold';
  paymentMethod: 'other_finance' | 'cash' | 'upfront';
  vehicleRc: string;
};

const dealerCache = new Map<string, DealerProfile>();
const leadCache = new Map<string, LeadProfile>();

// ---- public API ------------------------------------------------------------

export async function buildRealisticDealer(workerIndex = 0): Promise<DealerProfile> {
  const key = `${currentRunId()}::${workerIndex}`;
  const cached = dealerCache.get(key);
  if (cached) return cached;

  // Curated set of real Indian pincodes — known to resolve via India Post API.
  const pincode = faker.helpers.arrayElement(SEED_PINCODES);
  const postal = await lookupPincode(pincode);

  const ifsc = faker.helpers.arrayElement(SEED_IFSC_CODES);
  const bank = await lookupIfsc(ifsc);

  const ownerName = `${faker.person.firstName()} ${faker.person.lastName()}`;
  const fatherName = `${faker.person.firstName('male')} ${ownerName.split(' ').pop() ?? 'Kumar'}`;
  const dob = faker.date.birthdate({ min: 28, max: 55, mode: 'age' });
  const dobIso = dob.toISOString().slice(0, 10);
  const age = new Date().getFullYear() - dob.getFullYear();

  const baseCompany = `${faker.company.name()} EV Motors`;
  const pan = synthPan('C'); // company entity letter
  const gstin = synthGstin(STATE_GSTIN_CODE[postal.state] ?? '27', pan);

  const profile: DealerProfile = {
    runId: currentRunId(),
    companyName: tagCompany(baseCompany.slice(0, 60)),
    companyType: 'sole_proprietorship',
    companyAddressLine: `${faker.location.streetAddress()}, ${postal.city}`,
    pincode,
    city: postal.city,
    district: postal.district,
    state: postal.state,
    businessSummary: `Two-wheeler EV dealership operating across ${postal.city}.`,
    ownerName: tagDealer(ownerName),
    ownerEmail: prodEmail('owner'),
    ownerPhone: prodPhone(workerIndex),
    ownerDob: dobIso,
    ownerAge: age,
    fatherOrHusbandName: fatherName,
    bankName: bank.bank,
    bankBranch: bank.branch,
    bankIfsc: ifsc,
    bankAccountNumber: faker.finance.accountNumber(14),
    bankBeneficiary: ownerName,
    pan,
    gstin,
    aadhaar: synthAadhaar(),
    vehicleRc: synthVehicleRc(STATE_RTO_CODE[postal.state] ?? 'MH'),
  };

  dealerCache.set(key, profile);
  return profile;
}

export async function buildRealisticLead(workerIndex = 0): Promise<LeadProfile> {
  const key = `${currentRunId()}::${workerIndex}`;
  const cached = leadCache.get(key);
  if (cached) return cached;

  const pincode = faker.helpers.arrayElement(SEED_PINCODES);
  const postal = await lookupPincode(pincode);

  const fullName = `${faker.person.firstName()} ${faker.person.lastName()}`;
  const father = `${faker.person.firstName('male')} ${fullName.split(' ').pop() ?? 'Kumar'}`;
  const dob = faker.date.birthdate({ min: 21, max: 60, mode: 'age' }).toISOString().slice(0, 10);

  const profile: LeadProfile = {
    runId: currentRunId(),
    fullName: tagDealer(fullName),
    fatherOrHusbandName: father,
    phone: prodPhone(workerIndex + 50),
    email: prodEmail('lead'),
    dob,
    permanentAddress: `${faker.location.streetAddress()}, ${postal.city}`,
    pincode,
    city: postal.city,
    state: postal.state,
    pan: synthPan('P'),
    aadhaar: synthAadhaar(),
    interestLevel: faker.helpers.arrayElement(['hot', 'warm', 'cold'] as const),
    paymentMethod: faker.helpers.arrayElement(['other_finance', 'cash', 'upfront'] as const),
    vehicleRc: synthVehicleRc(STATE_RTO_CODE[postal.state] ?? 'MH'),
  };

  leadCache.set(key, profile);
  return profile;
}

// ---- network lookups -------------------------------------------------------

type PostalLookup = { city: string; district: string; state: string };

async function lookupPincode(pincode: string): Promise<PostalLookup> {
  const url = `https://api.postalpincode.in/pincode/${pincode}`;
  const data = await fetchJsonWithRetry(url);
  // Response shape: [{ Status, PostOffice: [{ Name, District, State, ... }] }]
  const office = Array.isArray(data) && data[0]?.PostOffice?.[0];
  if (!office) {
    throw new Error(
      `[realistic-data] India Post lookup empty for pincode ${pincode}: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }
  return {
    city: office.Name ?? office.District ?? 'Unknown',
    district: office.District ?? 'Unknown',
    state: office.State ?? 'Maharashtra',
  };
}

type IfscLookup = { bank: string; branch: string };

/**
 * Static fallback table for the seed IFSC codes — used if the Razorpay API
 * 404s or is rate-limiting. Values were spot-checked against the API on
 * 2026-04-26; if Razorpay returns something different at run time, the live
 * value wins.
 */
const IFSC_FALLBACK: Record<string, IfscLookup> = {
  HDFC0000001: { bank: 'HDFC BANK', branch: 'MUMBAI - SANDOZ HOUSE' },
  SBIN0000001: { bank: 'STATE BANK OF INDIA', branch: 'STATE BANK OF INDIA' },
  ICIC0000001: { bank: 'ICICI BANK LIMITED', branch: 'MUMBAI - DALAL STREET' },
  KKBK0000001: { bank: 'KOTAK MAHINDRA BANK LIMITED', branch: 'NARIMAN BHAVAN' },
  PUNB0000001: { bank: 'PUNJAB NATIONAL BANK', branch: 'NEW DELHI' },
  UTIB0000001: { bank: 'AXIS BANK', branch: 'MUMBAI - WORLI' },
};

async function lookupIfsc(ifsc: string): Promise<IfscLookup> {
  const url = `https://ifsc.razorpay.com/${ifsc}`;
  try {
    const data = await fetchJsonWithRetry(url);
    if (data?.BANK && data?.BRANCH) {
      return { bank: data.BANK, branch: data.BRANCH };
    }
  } catch (err) {
    // Fall through to static fallback.
    const fallback = IFSC_FALLBACK[ifsc];
    if (fallback) {
      console.warn(`[realistic-data] IFSC API failed for ${ifsc}, using fallback (${fallback.bank})`);
      return fallback;
    }
    throw err;
  }
  // API responded 200 but body shape was wrong — try fallback before giving up.
  const fallback = IFSC_FALLBACK[ifsc];
  if (fallback) return fallback;
  throw new Error(
    `[realistic-data] no API result and no fallback for IFSC ${ifsc}`,
  );
}

async function fetchJsonWithRetry(url: string, maxAttempts = 2): Promise<any> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 5_000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 400));
    }
  }
  throw new Error(
    `[realistic-data] fetch failed after ${maxAttempts} attempts: ${url} — ${(lastErr as Error)?.message ?? lastErr}`,
  );
}

// ---- synthetic identifier generators --------------------------------------

const PAN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randAlpha(n: number): string {
  return Array.from({ length: n }, () => PAN_ALPHABET[Math.floor(Math.random() * 26)]).join('');
}

function randDigits(n: number): string {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
}

/**
 * PAN structure: 5 alpha + 4 digits + 1 alpha. The 4th letter encodes entity:
 *   P = individual person, C = company, F = firm, H = HUF, T = trust.
 * We pin 4 = `entity` so that PAN regexes that check entity letter pass.
 */
export function synthPan(entity: 'P' | 'C' | 'F' | 'H' | 'T' = 'P'): string {
  const a = randAlpha(3);
  const fourth = entity;
  const fifth = randAlpha(1);
  const digits = randDigits(4);
  const checksum = randAlpha(1);
  return `${a}${fourth}${fifth}${digits}${checksum}`;
}

/**
 * GSTIN: <state><PAN><entity-num><Z><checksum>. Real GSTINs use a base-36
 * Verhoeff-like checksum; for client-side regex acceptance the checksum digit
 * just needs to be alphanumeric. We compute a deterministic letter from the
 * PAN so regenerated GSTINs collide-check the same way.
 */
export function synthGstin(stateCode: string, pan: string): string {
  if (!/^\d{2}$/.test(stateCode)) throw new Error(`stateCode must be 2 digits, got "${stateCode}"`);
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan)) throw new Error(`invalid pan for gstin: ${pan}`);
  const entityNum = '1';
  const z = 'Z';
  // pseudo-checksum: cycle sum of char codes mod 36 → 0-9A-Z
  const sum = (stateCode + pan + entityNum + z)
    .split('')
    .reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const map = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const checksum = map[sum % 36];
  return `${stateCode}${pan}${entityNum}${z}${checksum}`;
}

/**
 * Aadhaar: 12 digits, valid Verhoeff checksum on the first 11.
 * Implementation lifted from the public Verhoeff algorithm tables.
 */
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function verhoeffChecksum(digits: string): number {
  let c = 0;
  const reversed = digits.split('').reverse().map(Number);
  reversed.forEach((d, i) => {
    c = VERHOEFF_D[c][VERHOEFF_P[(i + 1) % 8][d]];
  });
  return VERHOEFF_D[c].indexOf(0); // inverse to satisfy: full string verhoeff == 0
}

export function synthAadhaar(): string {
  // First digit can't be 0 or 1 per UIDAI.
  const head = String(2 + Math.floor(Math.random() * 8));
  const middle = randDigits(10);
  const eleven = head + middle;
  const checksum = verhoeffChecksum(eleven);
  return `${eleven}${checksum}`;
}

export function synthVehicleRc(stateCode: string): string {
  // Pattern: SS NN AA NNNN  e.g. MH12AB1234
  const district = randDigits(2);
  const series = randAlpha(2);
  const num = randDigits(4);
  return `${stateCode.toUpperCase()}${district}${series}${num}`;
}

// ---- guard against accidental real identifiers ----------------------------

/**
 * Throw if `value` looks like a real identifier from a production registry.
 * Right now this is a noop placeholder — there's no offline way to detect
 * "real" PAN/Aadhaar without hitting an API. The function exists so call sites
 * can route validation through one place if/when a static deny-list is added.
 */
export function assertNotRealIdentifier(value: string, kind: 'pan' | 'aadhaar' | 'gstin'): void {
  if (!isProdRun()) return;
  // Static checks: identifiers we generated will always start with the entropy
  // bytes from synthPan/synthAadhaar — they're effectively never going to
  // collide with real ones, but if we ever introduce a hardcoded known PAN
  // (e.g. someone's personal one for happy-path testing) this is the choke point.
  void value;
  void kind;
}

// ---- curated lookup seeds --------------------------------------------------

/** Pincodes known to resolve via India Post API. Spread across major states. */
const SEED_PINCODES = [
  '400001', // Mumbai, MH
  '110001', // New Delhi, DL
  '560001', // Bangalore, KA
  '600001', // Chennai, TN
  '700001', // Kolkata, WB
  '500001', // Hyderabad, TS
  '411001', // Pune, MH
  '380001', // Ahmedabad, GJ
  '302001', // Jaipur, RJ
  '226001', // Lucknow, UP
];

/**
 * Seed IFSC codes — every entry is also keyed in IFSC_FALLBACK so a 404 from
 * Razorpay never breaks the run. Order is irrelevant.
 */
const SEED_IFSC_CODES = [
  'HDFC0000001',
  'SBIN0000001',
  'ICIC0000001',
  'KKBK0000001',
  'PUNB0000001',
  'UTIB0000001',
];

/** State name → 2-digit GSTIN state code (subset; covers SEED_PINCODES). */
const STATE_GSTIN_CODE: Record<string, string> = {
  Maharashtra: '27',
  Delhi: '07',
  Karnataka: '29',
  'Tamil Nadu': '33',
  'West Bengal': '19',
  Telangana: '36',
  Gujarat: '24',
  Rajasthan: '08',
  'Uttar Pradesh': '09',
};

/** State name → RTO state code prefix for vehicle registrations. */
const STATE_RTO_CODE: Record<string, string> = {
  Maharashtra: 'MH',
  Delhi: 'DL',
  Karnataka: 'KA',
  'Tamil Nadu': 'TN',
  'West Bengal': 'WB',
  Telangana: 'TS',
  Gujarat: 'GJ',
  Rajasthan: 'RJ',
  'Uttar Pradesh': 'UP',
};

// Re-export for external consumers wanting raw faker without re-instantiating
export { faker };
// Silence unused-warnings for re-exports kept for module-shape stability
void enInFaker;
void fakerEN_IN;
