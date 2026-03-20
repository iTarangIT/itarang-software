/**
 * Shared phone normalization and quality classification for Indian phone numbers.
 * Canonical format: +91XXXXXXXXXX (13 chars)
 */

export function normalizePhone(phone?: string | null): string | null {
    if (!phone) return null;
    let clean = phone.replace(/[^0-9]/g, '');

    // Strip country code if present
    if (clean.length === 12 && clean.startsWith('91')) {
        clean = clean.substring(2);
    }

    // Standard 10-digit Indian number
    if (clean.length === 10) {
        return `+91${clean}`;
    }

    // Already has + prefix, return as-is
    if (phone.startsWith('+')) return phone;

    // Fallback: prepend +91
    return `+91${clean}`;
}

export type PhoneQuality = 'valid' | 'missing' | 'invalid' | 'landline';

export function classifyPhoneQuality(phone?: string | null): PhoneQuality {
    if (!phone) return 'missing';

    const normalized = normalizePhone(phone);
    if (!normalized) return 'invalid';

    // Indian mobile: +91 followed by 6-9 then 9 digits (total 13 chars)
    if (/^\+91[6-9]\d{9}$/.test(normalized)) return 'valid';

    // Indian landline: +91 followed by area code starting with 2-5
    if (/^\+91[2-5]\d{9}$/.test(normalized)) return 'landline';

    return 'invalid';
}
