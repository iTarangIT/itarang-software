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

export function normalizeIndianPhone(
  phone: string | null | undefined,
): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0"))
    return `+91${digits.slice(1)}`;
  if (digits.length === 10) return `+91${digits}`;
  if (phone.startsWith("+") && digits.length >= 11) return `+${digits}`;
  return null;
}

// Return the 10-digit form used in dealer_leads. Returns null for anything
// that isn't a valid Indian mobile (must start with 6/7/8/9 after country).
export function toTenDigits(
  phone: string | null | undefined,
): string | null {
  const e164 = normalizeIndianPhone(phone);
  if (!e164) return null;
  const ten = e164.startsWith("+91") ? e164.slice(3) : e164.replace(/\D/g, "");
  if (ten.length !== 10) return null;
  if (!/^[6-9]/.test(ten)) return null;
  return ten;
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
