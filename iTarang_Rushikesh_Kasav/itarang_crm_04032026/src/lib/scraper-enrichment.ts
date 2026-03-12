import type { RawDealerRecord } from '@/types/scraper';

const CITY_ALIASES: Record<string, string> = {
    'blr': 'Bengaluru', 'bangalore': 'Bengaluru', 'bengaluru': 'Bengaluru',
    'dl': 'Delhi', 'new delhi': 'Delhi', 'delhi': 'Delhi',
    'mum': 'Mumbai', 'bombay': 'Mumbai', 'mumbai': 'Mumbai',
    'chn': 'Chennai', 'madras': 'Chennai', 'chennai': 'Chennai',
    'kol': 'Kolkata', 'calcutta': 'Kolkata', 'kolkata': 'Kolkata',
    'hyd': 'Hyderabad', 'hyderabad': 'Hyderabad',
    'ahd': 'Ahmedabad', 'amd': 'Ahmedabad', 'ahmedabad': 'Ahmedabad',
    'pune': 'Pune', 'pnq': 'Pune',
    'jpr': 'Jaipur', 'jaipur': 'Jaipur',
    'lko': 'Lucknow', 'lucknow': 'Lucknow',
    'pat': 'Patna', 'patna': 'Patna',
    'ind': 'Indore', 'indore': 'Indore',
    'bpl': 'Bhopal', 'bhopal': 'Bhopal',
    'ngp': 'Nagpur', 'nagpur': 'Nagpur',
    'guwahati': 'Guwahati', 'ghy': 'Guwahati',
};

const STATE_ALIASES: Record<string, string> = {
    'up': 'Uttar Pradesh', 'uttar pradesh': 'Uttar Pradesh',
    'mp': 'Madhya Pradesh', 'madhya pradesh': 'Madhya Pradesh',
    'mh': 'Maharashtra', 'maharashtra': 'Maharashtra',
    'ka': 'Karnataka', 'karnataka': 'Karnataka',
    'tn': 'Tamil Nadu', 'tamil nadu': 'Tamil Nadu',
    'wb': 'West Bengal', 'west bengal': 'West Bengal',
    'rj': 'Rajasthan', 'rajasthan': 'Rajasthan',
    'gj': 'Gujarat', 'gujarat': 'Gujarat',
    'ap': 'Andhra Pradesh', 'andhra pradesh': 'Andhra Pradesh',
    'ts': 'Telangana', 'telangana': 'Telangana',
    'dl': 'Delhi', 'delhi': 'Delhi',
    'br': 'Bihar', 'bihar': 'Bihar',
    'hr': 'Haryana', 'haryana': 'Haryana',
    'pb': 'Punjab', 'punjab': 'Punjab',
    'or': 'Odisha', 'odisha': 'Odisha',
    'jh': 'Jharkhand', 'jharkhand': 'Jharkhand',
    'cg': 'Chhattisgarh', 'chhattisgarh': 'Chhattisgarh',
    'as': 'Assam', 'assam': 'Assam',
    'uk': 'Uttarakhand', 'uttarakhand': 'Uttarakhand',
};

export function normalizeCity(city: string | undefined): string | undefined {
    if (!city) return undefined;
    const key = city.trim().toLowerCase();
    return CITY_ALIASES[key] ?? city.trim();
}

export function normalizeState(state: string | undefined): string | undefined {
    if (!state) return undefined;
    const key = state.trim().toLowerCase();
    return STATE_ALIASES[key] ?? state.trim();
}

export function isPhoneValid(phone: string | undefined): boolean {
    if (!phone) return false;
    return /^\+91\d{10}$/.test(phone);
}

export function calculateQualityScore(record: RawDealerRecord): number {
    let score = 0;
    if (record.phone) score++;
    if (record.city) score++;
    if (record.dealer_name && record.dealer_name.length > 3) score++;
    if (record.source_url) score++;
    if (record.state || record.address) score++;
    return Math.max(1, score);
}

export function enrichRecord(record: RawDealerRecord): RawDealerRecord & {
    quality_score: number;
    phone_valid: boolean;
} {
    return {
        ...record,
        city: normalizeCity(record.city),
        state: normalizeState(record.state),
        quality_score: calculateQualityScore(record),
        phone_valid: isPhoneValid(record.phone),
    };
}
