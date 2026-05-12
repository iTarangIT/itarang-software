// Canonical phone-format utilities. Treated as the single source of truth
// for Indian mobile validation across scraper + dialer code paths.
//
// The two storage formats currently in use:
//   - scraper_leads.phone  →  "+91XXXXXXXXXX" (E.164)
//   - dealer_leads.phone   →  "XXXXXXXXXX"    (10 digits, no country code)
//
// Wire format expected by Bolna and ElevenLabs is E.164. To avoid a risky
// DB-wide migration, we keep both storage formats but always validate input
// through normalizeIndianPhone — and lookups go through phoneLookupVariants
// so a single phone matches regardless of which table holds it.

// Strip everything after an extension marker (ext / ext. / x / #) so we don't
// concatenate the extension digits onto the main number when stripping
// non-digit characters. Without this, "9876543210 ext 123" would collapse to
// "9876543210123" (13 digits) and get rejected for length, and 12-digit
// variants would be mistaken for "91"-prefixed numbers.
function stripExtension(raw: string): string {
  return raw.split(/(?:ext\.?|x|#)/i)[0] ?? raw;
}

export function normalizeIndianPhone(
  phone: string | null | undefined,
): string | null {
  if (!phone) return null;
  const digits = stripExtension(String(phone)).replace(/[^0-9]/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0"))
    return `+91${digits.slice(1)}`;
  if (digits.length === 10) return `+91${digits}`;
  if (phone.startsWith("+") && digits.length >= 11) return `+${digits}`;
  return null;
}

// Return the 10-digit form used in dealer_leads. Returns null for anything
// that isn't a valid Indian mobile (must start with 6/7/8/9 after country).
//
// Google Places hands phones back in many shapes — "+91 98765 43210",
// "091-98765-43210", "(+91) 9876543210", "9876543210 ext 12" — so we strip
// all non-digits first and only then judge length / prefix. The 10-digit
// canonical form is what goes into dealer_leads.phone (UNIQUE).
export function toTenDigits(
  phone: string | null | undefined,
): string | null {
  if (!phone) return null;
  let digits = stripExtension(String(phone)).replace(/\D/g, "");
  // Peel leading zeros (Indian trunk prefix, sometimes doubled as "00").
  // Covers both "09876543210" (11) and "00919876543210" (14, intl 00-prefix).
  if (digits.length >= 11 && digits.startsWith("0")) {
    digits = digits.replace(/^0+/, "");
  }
  // Then peel the 91 country code if present.
  if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  }
  if (digits.length !== 10) return null;
  if (!/^[6-9]/.test(digits)) return null;
  return digits;
}

// Return every storage variant we might find in the DB for a given input,
// for use in `inArray()` lookups. Today: [E.164, 10-digit]. When the DB
// migrates to a single canonical format, this collapses to one entry.
export function phoneLookupVariants(
  phone: string | null | undefined,
): string[] {
  const e164 = normalizeIndianPhone(phone);
  if (!e164) return phone ? [phone] : [];
  const ten = e164.startsWith("+91") ? e164.slice(3) : null;
  const variants = [e164];
  if (ten) variants.push(ten);
  return variants;
}
