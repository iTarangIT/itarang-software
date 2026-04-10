/**
 * Parse bank details (account number, IFSC, bank name, branch) from raw Tesseract OCR text.
 * Tesseract output is noisy — results should be treated as low-confidence suggestions.
 */

const KNOWN_BANKS = [
  'STATE BANK OF INDIA', 'SBI',
  'HDFC BANK', 'HDFC',
  'ICICI BANK', 'ICICI',
  'AXIS BANK', 'AXIS',
  'KOTAK MAHINDRA BANK', 'KOTAK',
  'PUNJAB NATIONAL BANK', 'PNB',
  'BANK OF BARODA', 'BOB',
  'CANARA BANK',
  'UNION BANK OF INDIA',
  'INDIAN BANK',
  'BANK OF INDIA', 'BOI',
  'CENTRAL BANK OF INDIA',
  'INDIAN OVERSEAS BANK', 'IOB',
  'UCO BANK',
  'BANDHAN BANK',
  'IDBI BANK', 'IDBI',
  'YES BANK',
  'FEDERAL BANK',
  'INDUSIND BANK',
  'SOUTH INDIAN BANK',
  'KARNATAKA BANK',
  'CITY UNION BANK',
  'TAMILNAD MERCANTILE BANK',
  'DHANLAXMI BANK',
  'JAMMU AND KASHMIR BANK',
  'RBL BANK',
  'AU SMALL FINANCE BANK',
  'EQUITAS SMALL FINANCE BANK',
  'UJJIVAN SMALL FINANCE BANK',
];

export interface BankDocResult {
  accountNumber?: string;
  ifsc?: string;
  bankName?: string;
  branch?: string;
}

/** Extract IFSC code (4 letters + 0 + 6 alphanumeric) */
function parseIfsc(text: string): string | undefined {
  const match = text.match(/[A-Z]{4}0[A-Z0-9]{6}/);
  return match?.[0];
}

/** Extract account number — 9-18 digit sequences, prefer ones near keywords */
function parseAccountNumber(text: string): string | undefined {
  const lines = text.split('\n');

  // First try: look for account number near keywords
  for (const line of lines) {
    const upper = line.toUpperCase();
    if (upper.includes('A/C') || upper.includes('ACCOUNT') || upper.includes('ACCT')) {
      const digits = line.match(/\d{9,18}/);
      if (digits) return digits[0];
    }
  }

  // Fallback: find any 9-18 digit sequence (skip phone-length numbers)
  const allDigits = text.match(/\d{9,18}/g) || [];
  // Filter out 10-digit sequences that look like phone numbers
  const candidates = allDigits.filter(d => d.length !== 10);
  return candidates[0] || allDigits[0];
}

/** Match bank name against known list */
function parseBankName(text: string): string | undefined {
  const upper = text.toUpperCase();
  for (const bank of KNOWN_BANKS) {
    if (upper.includes(bank)) return bank;
  }
  return undefined;
}

/** Extract branch name — look near "Branch" keyword */
function parseBranch(text: string): string | undefined {
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/branch\s*[:\-]?\s*(.+)/i);
    if (match?.[1]) {
      const branch = match[1].trim().replace(/[,.]$/, '');
      if (branch.length > 2 && branch.length < 100) return branch;
    }
  }
  return undefined;
}

/** Parse bank document text from Tesseract OCR into structured fields */
export function parseBankDocument(text: string): BankDocResult {
  return {
    accountNumber: parseAccountNumber(text),
    ifsc: parseIfsc(text),
    bankName: parseBankName(text),
    branch: parseBranch(text),
  };
}
