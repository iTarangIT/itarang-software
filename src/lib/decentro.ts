/**
 * Decentro KYC API Client
 * Set DECENTRO_BASE_URL to switch between environments:
 *   Sandbox:    https://in.staging.decentro.tech
 *   Production: https://in.decentro.tech
 */

const BASE_URL = process.env.DECENTRO_BASE_URL || (
    process.env.NODE_ENV === 'production'
        ? 'https://in.decentro.tech'
        : 'https://in.staging.decentro.tech'
);
const CLIENT_ID = process.env.DECENTRO_CLIENT_ID!;
const CLIENT_SECRET = process.env.DECENTRO_CLIENT_SECRET!;
const MODULE_SECRET_BANKING = process.env.DECENTRO_MODULE_SECRET_BANKING;
const MODULE_SECRET_CREDIT = process.env.DECENTRO_MODULE_SECRET_CREDIT;
const PROVIDER_SECRET = process.env.DECENTRO_PROVIDER_SECRET;

function genRefId(): string {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
    return `ITR-${ts}-${rand}`;
}

function isRealSecret(val?: string): boolean {
    return !!val && !val.startsWith('your_') && val.length > 5;
}

function kycHeaders(): Record<string, string> {
    // Per Decentro: KYC endpoints authenticate with client_id + client_secret only.
    return {
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
        'Content-Type': 'application/json',
        'accept': 'application/json',
    };
}

function bankingHeaders(): Record<string, string> {
    const h: Record<string, string> = {
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
        'Content-Type': 'application/json',
    };
    if (isRealSecret(MODULE_SECRET_BANKING)) h['module_secret'] = MODULE_SECRET_BANKING!;
    return h;
}

// ─── Public Registry Validate (PAN / GSTIN / Voter ID / DL) ─────────────────

export type PublicRegistryDocType =
    | 'PAN' | 'PAN-DETAILED' | 'PAN_DETAILED_COMPLETE' | 'PAN_BANK_ACCOUNT_LINKAGE' | 'PAN-MATCH' | 'PAN_COMPARE'
    | 'GSTIN' | 'GSTIN_DETAILED'
    | 'VOTERID'
    | 'DRIVING_LICENSE'
    | 'FSSAI' | 'UDYOG_AADHAAR' | 'CIN' | 'DIN';

export interface ValidateDocParams {
    document_type: PublicRegistryDocType;
    id_number: string;
    consent_purpose?: string;
    dob?: string;           // Required for DRIVING_LICENSE (YYYY-MM-DD)
    generate_pdf?: boolean;
}

export async function validateDocument(params: ValidateDocParams) {
    const body: Record<string, unknown> = {
        reference_id: genRefId(),
        document_type: params.document_type,
        id_number: params.id_number,
        consent: 'Y',
        consent_purpose: params.consent_purpose || 'For bank account purpose only',
    };
    if (params.dob) body.dob = params.dob;
    if (params.generate_pdf) body.generate_pdf = true;

    const res = await fetch(`${BASE_URL}/kyc/public_registry/validate`, {
        method: 'POST',
        headers: kycHeaders(),
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
        console.error('[Decentro validateDocument] HTTP', res.status, JSON.stringify(data));
        return { responseStatus: 'ERROR', status: 'ERROR', message: data?.message || data?.error || `Decentro API returned HTTP ${res.status}`, ...data };
    }
    return data;
}

// ─── Aadhaar OTP ─────────────────────────────────────────────────────────────

export async function aadhaarGenerateOtp(aadhaar_number: string) {
    const res = await fetch(`${BASE_URL}/v2/kyc/aadhaar/otp`, {
        method: 'POST',
        headers: kycHeaders(),
        body: JSON.stringify({
            reference_id: genRefId(),
            aadhaar_number,
            consent: 'Y',
            consent_purpose: 'Customer Aadhaar verification for loan processing',
        }),
    });
    return res.json();
}

export async function aadhaarValidateOtp(decentro_txn_id: string, otp: string) {
    const res = await fetch(`${BASE_URL}/v2/kyc/aadhaar/otp/validate`, {
        method: 'POST',
        headers: kycHeaders(),
        body: JSON.stringify({
            reference_id: genRefId(),
            decentro_txn_id,
            otp,
        }),
    });
    return res.json();
}

// ─── Bank Account Verification (V2) ─────────────────────────────────────────
// POST /core_banking/money_transfer/validate_account
// Auth: client_id + client_secret + module_secret (core banking) + provider_secret

export interface BankVerifyParams {
    account_number: string;
    ifsc: string;
    name?: string;
    mobile_number?: string;
    perform_name_match?: boolean;
    validation_type?: 'penniless' | 'pennydrop' | 'hybrid';
}

function coreBankingHeaders(): Record<string, string> {
    const h: Record<string, string> = {
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
        'Content-Type': 'application/json',
        'accept': 'application/json',
    };
    if (isRealSecret(MODULE_SECRET_BANKING)) h['module_secret'] = MODULE_SECRET_BANKING!;
    if (isRealSecret(PROVIDER_SECRET)) h['provider_secret'] = PROVIDER_SECRET!;
    return h;
}

export async function verifyBankAccount(params: BankVerifyParams) {
    if (!isRealSecret(MODULE_SECRET_BANKING) || !isRealSecret(PROVIDER_SECRET)) {
        return {
            responseStatus: 'ERROR',
            status: 'ERROR',
            message:
                'DECENTRO_MODULE_SECRET_BANKING and DECENTRO_PROVIDER_SECRET must be set in .env.local for v2 bank verification.',
        };
    }

    const body: Record<string, unknown> = {
        reference_id: genRefId(),
        purpose_message: 'Account verification for loan application',
        validation_type: params.validation_type || 'penniless',
        perform_name_match: params.perform_name_match ?? !!params.name,
        beneficiary_details: {
            account_number: params.account_number,
            ifsc: params.ifsc,
            ...(params.name ? { name: params.name } : {}),
        },
    };

    const res = await fetch(`${BASE_URL}/core_banking/money_transfer/validate_account`, {
        method: 'POST',
        headers: coreBankingHeaders(),
        body: JSON.stringify(body),
    });
    return res.json();
}

// ─── Face Match ───────────────────────────────────────────────────────────────

export async function faceMatch(image1: Blob, image2: Blob) {
    const form = new FormData();
    form.append('reference_id', genRefId());
    form.append('consent', 'Y');
    form.append('consent_purpose', 'Face match for customer identity verification');
    form.append('image1', image1, 'image1.jpg');
    form.append('image2', image2, 'image2.jpg');

    const headers: Record<string, string> = {
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
    };

    const res = await fetch(`${BASE_URL}/v2/kyc/forensics/face_match`, {
        method: 'POST',
        headers,
        body: form,
    });
    return res.json();
}

// ─── Document Classification ──────────────────────────────────────────────────

export type ClassificationDocType = 'PAN' | 'AADHAAR' | 'AADHAAR_BACK' | 'DRIVING_LICENSE' | 'VOTERID' | 'PASSPORT' | 'CHEQUE' | 'BANK_STATEMENT' | 'RC' | 'UNKNOWN';

const DOC_TYPE_TO_CLASSIFICATION: Record<string, ClassificationDocType> = {
    'aadhaar_front': 'AADHAAR',
    'aadhaar_back': 'AADHAAR_BACK',
    'pan_card': 'PAN',
    'passport_photo': 'PASSPORT',
    'address_proof': 'AADHAAR',
    'rc_copy': 'RC',
    'bank_statement': 'BANK_STATEMENT',
    'cheque_1': 'CHEQUE',
    'cheque_2': 'CHEQUE',
    'cheque_3': 'CHEQUE',
    'cheque_4': 'CHEQUE',
};

export function getExpectedDocClass(docType: string): ClassificationDocType {
    return DOC_TYPE_TO_CLASSIFICATION[docType] || 'UNKNOWN';
}

export async function classifyDocument(documentBlob: Blob, filename: string) {
    const lastDot = filename.lastIndexOf('.');
    const sanitizedFilename = lastDot > 0
        ? filename.slice(0, lastDot).replace(/\./g, '_') + filename.slice(lastDot)
        : filename;

    const form = new FormData();
    form.append('reference_id', genRefId());
    form.append('consent', 'Y');
    form.append('consent_purpose', 'Document classification for KYC verification');
    form.append('document', documentBlob, sanitizedFilename);

    const headers: Record<string, string> = {
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
    };

    try {
        const res = await fetch(`${BASE_URL}/kyc/document/classify`, {
            method: 'POST',
            headers,
            body: form,
        });
        return res.json();
    } catch {
        // Classification API may not be available - return null to allow fallback
        return null;
    }
}

// ─── Document OCR ─────────────────────────────────────────────────────────────

export type OcrDocType = 'PAN' | 'AADHAAR' | 'DRIVING_LICENSE' | 'VOTERID' | 'PASSPORT';

export async function extractDocumentOcr(document_type: OcrDocType, documentBlob: Blob, filename: string) {
    // Decentro rejects filenames with multiple periods — sanitize by keeping only the last one (extension)
    const lastDot = filename.lastIndexOf('.');
    const sanitizedFilename = lastDot > 0
        ? filename.slice(0, lastDot).replace(/\./g, '_') + filename.slice(lastDot)
        : filename;

    const form = new FormData();
    form.append('reference_id', genRefId());
    form.append('document_type', document_type);
    form.append('consent', 'Y');
    form.append('consent_purpose', 'Document OCR extraction for KYC verification');
    form.append('kyc_validate', '1');
    form.append('document', documentBlob, sanitizedFilename);

    const headers: Record<string, string> = {
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
    };

    const url = `${BASE_URL}/kyc/scan_extract/ocr`;
    console.log(`[Decentro OCR] POST ${url} document_type=${document_type} file=${filename} size=${documentBlob.size}`);

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: form,
    });

    const json = await res.json();
    console.log(`[Decentro OCR] Response status=${res.status}:`, JSON.stringify(json).slice(0, 500));
    return json;
}

// ─── OCR Data Comparison Helpers ──────────────────────────────────────────────

export interface OcrComparisonField {
    field: string;
    label: string;
    ocrValue: string | null;
    leadValue: string | null;
    match: boolean;
    similarity?: number;
}

function normalizeString(s: string | null | undefined): string {
    return (s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function stringSimilarity(a: string, b: string): number {
    const na = normalizeString(a);
    const nb = normalizeString(b);
    if (!na || !nb) return 0;
    if (na === nb) return 100;

    // Simple Levenshtein-based similarity
    const longer = na.length > nb.length ? na : nb;
    const shorter = na.length > nb.length ? nb : na;
    if (longer.length === 0) return 100;

    const costs: number[] = [];
    for (let i = 0; i <= shorter.length; i++) {
        let lastValue = i;
        for (let j = 0; j <= longer.length; j++) {
            if (i === 0) { costs[j] = j; }
            else if (j > 0) {
                let newValue = costs[j - 1];
                if (shorter.charAt(i - 1) !== longer.charAt(j - 1)) {
                    newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
                }
                costs[j - 1] = lastValue;
                lastValue = newValue;
            }
        }
        if (i > 0) costs[longer.length] = lastValue;
    }
    return Math.round(((longer.length - costs[longer.length]) / longer.length) * 100);
}

export function compareOcrWithLead(
    ocrData: Record<string, any>,
    leadData: { full_name?: string; father_or_husband_name?: string; dob?: string; phone?: string; current_address?: string },
    _docType: string
): OcrComparisonField[] {
    const comparisons: OcrComparisonField[] = [];

    // Extract name from OCR based on doc type
    const ocrName = ocrData?.name || ocrData?.full_name || ocrData?.nameOnCard || null;
    if (ocrName || leadData.full_name) {
        const sim = stringSimilarity(ocrName, leadData.full_name || '');
        comparisons.push({
            field: 'name',
            label: 'Full Name',
            ocrValue: ocrName,
            leadValue: leadData.full_name || null,
            match: sim >= 80,
            similarity: sim,
        });
    }

    // Father/Husband Name
    const ocrFather = ocrData?.fatherName || ocrData?.father_name || ocrData?.fatherOrHusbandName || null;
    if (ocrFather || leadData.father_or_husband_name) {
        const sim = stringSimilarity(ocrFather, leadData.father_or_husband_name || '');
        comparisons.push({
            field: 'father_name',
            label: 'Father/Husband Name',
            ocrValue: ocrFather,
            leadValue: leadData.father_or_husband_name || null,
            match: sim >= 80,
            similarity: sim,
        });
    }

    // Date of Birth
    const ocrDob = ocrData?.dob || ocrData?.dateOfBirth || ocrData?.date_of_birth || null;
    if (ocrDob || leadData.dob) {
        const leadDobStr = leadData.dob ? new Date(leadData.dob).toISOString().slice(0, 10) : '';
        const ocrDobNorm = ocrDob ? normalizeDate(ocrDob) : '';
        comparisons.push({
            field: 'dob',
            label: 'Date of Birth',
            ocrValue: ocrDob,
            leadValue: leadDobStr || null,
            match: ocrDobNorm === leadDobStr,
            similarity: ocrDobNorm === leadDobStr ? 100 : 0,
        });
    }

    // Address (for Aadhaar)
    const ocrAddress = ocrData?.address || ocrData?.currentAddress || null;
    if (ocrAddress || leadData.current_address) {
        const sim = stringSimilarity(ocrAddress, leadData.current_address || '');
        comparisons.push({
            field: 'address',
            label: 'Address',
            ocrValue: ocrAddress,
            leadValue: leadData.current_address || null,
            match: sim >= 70,
            similarity: sim,
        });
    }

    return comparisons;
}

function normalizeDate(dateStr: string): string {
    // Try various date formats and convert to YYYY-MM-DD
    const cleaned = dateStr.replace(/[/\\]/g, '-');
    // DD-MM-YYYY
    const ddmmyyyy = cleaned.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (ddmmyyyy) return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
    // YYYY-MM-DD
    const yyyymmdd = cleaned.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (yyyymmdd) return cleaned;
    // Try Date parsing
    try {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    } catch { /* ignore */ }
    return dateStr;
}

// Export helpers for reuse in cross-match module
export { stringSimilarity, normalizeString, normalizeDate };

// ─── DigiLocker eAadhaar (two-step flow) ────────────────────────────────────
// Step 1: Initiate Session → get auth URL + decentro_transaction_id
// Step 2: Get eAadhaar     → fetch Aadhaar data using transaction ID

export interface DigilockerInitSessionParams {
    reference_id: string;
    redirect_url: string;
    consent_purpose?: string;
    mobile_number?: string;
    email?: string | null;
    notification_channel?: 'sms' | 'whatsapp' | 'email' | 'both';
}

/** Step 1: Initiate DigiLocker session — returns auth URL for customer */
export async function digilockerInitiateSession(params: DigilockerInitSessionParams) {
    const body: Record<string, unknown> = {
        reference_id: params.reference_id,
        consent: true,
        consent_purpose: params.consent_purpose || 'Aadhaar verification for loan application',
        redirect_url: params.redirect_url,
        redirect_to_signup: false,
        abstract_access_token: true,
    };

    // Send notification to customer so they receive the DigiLocker link
    if (params.mobile_number) {
        const phone = params.mobile_number.replace(/\D/g, '').slice(-10);
        const channel = params.notification_channel || 'sms';

        if (channel === 'sms' || channel === 'both') {
            body.notifications = {
                ...(body.notifications as object || {}),
                sms: { mobile_number: phone },
            };
        }
        if (channel === 'whatsapp' || channel === 'both') {
            body.notifications = {
                ...(body.notifications as object || {}),
                whatsapp: { mobile_number: phone },
            };
        }
        if (channel === 'email' && params.email) {
            body.notifications = {
                ...(body.notifications as object || {}),
                email: { email_id: params.email },
            };
        }
    }

    const res = await fetch(`${BASE_URL}/v2/kyc/digilocker/initiate_session`, {
        method: 'POST',
        headers: kycHeaders(),
        body: JSON.stringify(body),
    });
    return res.json();
}

// Alias for backward compatibility with existing imports
export const digilockerSsoInit = digilockerInitiateSession;

export interface DigilockerGetEaadhaarParams {
    initial_decentro_transaction_id: string;
    reference_id: string;
    consent_purpose?: string;
    generate_xml?: boolean;
    generate_pdf?: boolean;
}

/** Step 2: Fetch eAadhaar data using the transaction ID from initiate_session */
export async function digilockerGetEaadhaar(params: DigilockerGetEaadhaarParams) {
    const body = {
        initial_decentro_transaction_id: params.initial_decentro_transaction_id,
        consent: true,
        consent_purpose: params.consent_purpose || 'Aadhaar verification for loan application',
        reference_id: params.reference_id,
        generate_xml: params.generate_xml ?? false,
        generate_pdf: params.generate_pdf ?? false,
    };

    const res = await fetch(`${BASE_URL}/v2/kyc/digilocker/eaadhaar`, {
        method: 'POST',
        headers: kycHeaders(),
        body: JSON.stringify(body),
    });
    return res.json();
}

/** Check status / fetch eAadhaar — calls the eAadhaar endpoint with the transaction ID */
export async function digilockerCheckStatus(decentroTxnId: string) {
    return digilockerGetEaadhaar({
        initial_decentro_transaction_id: decentroTxnId,
        reference_id: genRefId(),
    });
}

// ─── Credit Bureau (Equifax via Decentro) ───────────────────────────────────
// Score:       POST /v2/bytes/credit-score       (lightweight — mobile + name)
// Report:      POST /v2/financial_services/credit_bureau/credit_report/summary

function creditHeaders(): Record<string, string> {
    const h: Record<string, string> = {
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
        'Content-Type': 'application/json',
        'accept': 'application/json',
    };
    // Per Decentro: CIBIL/credit-bureau endpoints authenticate with client_id +
    // client_secret only. Sending a module_secret scoped to a different module
    // (e.g. KYC) triggers E00030 error_unauthorized_module. Only attach one if
    // an explicit credit-module secret is configured.
    if (isRealSecret(MODULE_SECRET_CREDIT)) h['module_secret'] = MODULE_SECRET_CREDIT!;
    return h;
}

export interface CibilParams {
    name: string;
    pan: string;
    dob: string;      // YYYY-MM-DD
    phone: string;
    address: string;
    pincode?: string;      // 6-digit Indian pincode — bureau lookup uses this
    address_type?: 'H' | 'O' | 'X';   // H=Home, O=Office, X=Other (defaults to H)
}

/** Credit score via Bytes module (lightweight — mobile + name only).
 *  Name is uppercased to match the canonical PAN-card format that CIBIL
 *  typically stores against each PAN. */
export async function fetchCibilScore(params: CibilParams) {
    const body = {
        mobile: params.phone.replace(/\D/g, '').slice(-10),
        name: params.name.trim().toUpperCase(),
    };

    console.log('[CIBIL Score] Request body:', JSON.stringify({
        ...body,
        mobile: `******${body.mobile.slice(-4)}`,
    }));

    const res = await fetch(`${BASE_URL}/v2/bytes/credit-score`, {
        method: 'POST',
        headers: creditHeaders(),
        body: JSON.stringify(body),
    });
    return res.json();
}

/** Full credit report summary — returns score + accounts + enquiries
 *  Decentro requires: reference_id, consent, consent_purpose, name, mobile,
 *  inquiry_purpose, date_of_birth, address_type, address, pincode, document_type,
 *  document_id. Missing pincode/address_type degrades the bureau match and often
 *  returns "Consumer not found" even for leads that do exist on CIBIL. */
export async function fetchCibilReport(params: CibilParams) {
    const pincode = (params.pincode || '').replace(/\D/g, '').slice(0, 6)
        || (params.address.match(/\b\d{6}\b/)?.[0] ?? '');

    const body: Record<string, unknown> = {
        reference_id: genRefId(),
        consent: true,
        consent_purpose: 'Credit report for loan application processing',
        name: params.name.trim().toUpperCase(),
        mobile: params.phone.replace(/\D/g, '').slice(-10),
        inquiry_purpose: 'PL',
        address_type: params.address_type || 'H',
    };

    if (params.pan) {
        body.document_type = 'PAN';
        body.document_id = params.pan.toUpperCase().trim();
    }
    if (params.dob) body.date_of_birth = params.dob;
    if (params.address) body.address = params.address;
    if (pincode) body.pincode = pincode;

    console.log('[CIBIL Report] Request body:', JSON.stringify({
        ...body,
        document_id: body.document_id ? `${String(body.document_id).slice(0, 3)}****${String(body.document_id).slice(-2)}` : undefined,
        mobile: body.mobile ? `******${String(body.mobile).slice(-4)}` : undefined,
    }));

    const res = await fetch(`${BASE_URL}/v2/financial_services/credit_bureau/credit_report/summary`, {
        method: 'POST',
        headers: creditHeaders(),
        body: JSON.stringify(body),
    });
    return res.json();
}

// ─── RC to Chassis (Vehicle) ─────────────────────────────────────────────────
// Staging: POST /v2/bytes/converter/rc/chassis

export async function verifyRcNumber(rc_number: string) {
    const body = {
        reference_id: genRefId(),
        consent: true,
        purpose: 'Vehicle RC verification for loan',
        id: rc_number.toUpperCase().trim().replace(/[^A-Z0-9]/g, ''),
    };

    const res = await fetch(`${BASE_URL}/v2/bytes/converter/rc/chassis`, {
        method: 'POST',
        headers: kycHeaders(),
        body: JSON.stringify(body),
    });
    return res.json();
}
