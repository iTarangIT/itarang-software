/**
 * Decentro KYC API Client (Staging)
 * Base: https://in.staging.decentro.tech
 */

const BASE_URL = process.env.DECENTRO_BASE_URL || 'https://in.staging.decentro.tech';
const CLIENT_ID = process.env.DECENTRO_CLIENT_ID!;
const CLIENT_SECRET = process.env.DECENTRO_CLIENT_SECRET!;
const MODULE_SECRET_KYC = process.env.DECENTRO_MODULE_SECRET_KYC;
const MODULE_SECRET_BANKING = process.env.DECENTRO_MODULE_SECRET_BANKING;

function genRefId(): string {
    const ts = Date.now().toString(36).toUpperCase();
    const rand = Math.random().toString(36).slice(2, 7).toUpperCase();
    return `ITR-${ts}-${rand}`;
}

function isRealSecret(val?: string): boolean {
    return !!val && !val.startsWith('your_') && val.length > 5;
}

function kycHeaders(): Record<string, string> {
    const h: Record<string, string> = {
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
        'Content-Type': 'application/json',
    };
    if (isRealSecret(MODULE_SECRET_KYC)) h['module_secret'] = MODULE_SECRET_KYC!;
    return h;
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
    | 'PAN' | 'PAN_DETAILED'
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
        consent_purpose: params.consent_purpose || 'Customer identity verification for loan processing',
        generate_pdf: params.generate_pdf ?? false,
    };
    if (params.dob) body.dob = params.dob;

    const res = await fetch(`${BASE_URL}/kyc/public_registry/validate`, {
        method: 'POST',
        headers: kycHeaders(),
        body: JSON.stringify(body),
    });
    return res.json();
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

// ─── Bank Account Verification ───────────────────────────────────────────────

export interface BankVerifyParams {
    account_number: string;
    ifsc: string;
    name?: string;
    perform_name_match?: boolean;
    validation_type?: 'penniless' | 'pennydrop' | 'hybrid';
}

export async function verifyBankAccount(params: BankVerifyParams) {
    const body: Record<string, unknown> = {
        reference_id: genRefId(),
        purpose_message: 'Account verification for loan application',
        transfer_amount: 1,
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
        headers: bankingHeaders(),
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
    if (isRealSecret(MODULE_SECRET_KYC)) headers['module_secret'] = MODULE_SECRET_KYC!;

    const res = await fetch(`${BASE_URL}/v2/kyc/forensics/face_match`, {
        method: 'POST',
        headers,
        body: form,
    });
    return res.json();
}

// ─── DigiLocker (Aadhaar) ─────────────────────────────────────────────────────

export interface DigilockerInitiateParams {
    reference_id?: string;
    redirect_url: string;
    consent_purpose?: string;
    notification_channel?: 'sms' | 'whatsapp' | 'email' | 'both';
    mobile_number?: string;
    email?: string | null;
}

export async function digilockerInitiateSession(params: DigilockerInitiateParams) {
    const body: Record<string, unknown> = {
        reference_id: params.reference_id || genRefId(),
        redirect_url: params.redirect_url,
        consent: 'Y',
        consent_purpose: params.consent_purpose || 'Customer Aadhaar verification for loan processing',
        notification_channel: params.notification_channel || 'sms',
    };
    if (params.mobile_number) body.mobile_number = params.mobile_number;
    if (params.email) body.email = params.email;

    const res = await fetch(`${BASE_URL}/v2/kyc/digilocker/initiate_session`, {
        method: 'POST',
        headers: kycHeaders(),
        body: JSON.stringify(body),
    });
    return res.json();
}

export async function digilockerCheckStatus(decentroTxnId: string) {
    const res = await fetch(
        `${BASE_URL}/v2/kyc/digilocker/check_status?decentro_txn_id=${encodeURIComponent(decentroTxnId)}`,
        {
            method: 'GET',
            headers: kycHeaders(),
        },
    );
    return res.json();
}

export interface DigilockerGetEaadhaarParams {
    initial_decentro_transaction_id: string;
    reference_id?: string;
}

export async function digilockerGetEaadhaar(params: DigilockerGetEaadhaarParams) {
    const body = {
        reference_id: params.reference_id || genRefId(),
        initial_decentro_transaction_id: params.initial_decentro_transaction_id,
        consent: 'Y',
        consent_purpose: 'Retrieve eAadhaar for KYC verification',
    };

    const res = await fetch(`${BASE_URL}/v2/kyc/digilocker/eaadhaar`, {
        method: 'POST',
        headers: kycHeaders(),
        body: JSON.stringify(body),
    });
    return res.json();
}

// ─── CIBIL (Credit Bureau) ────────────────────────────────────────────────────

export interface CibilParams {
    name: string;
    pan: string;
    dob: string;
    phone: string;
    address?: string;
}

function cibilBody(params: CibilParams): Record<string, unknown> {
    return {
        reference_id: genRefId(),
        consent: 'Y',
        consent_purpose: 'Customer credit assessment for loan processing',
        name: params.name,
        pan: params.pan,
        mobile: params.phone,
        dob: params.dob,
        address: params.address || '',
    };
}

export async function fetchCibilScore(params: CibilParams) {
    const res = await fetch(`${BASE_URL}/v2/bytes/credit-score`, {
        method: 'POST',
        headers: kycHeaders(),
        body: JSON.stringify(cibilBody(params)),
    });
    return res.json();
}

export async function fetchCibilReport(params: CibilParams) {
    const res = await fetch(
        `${BASE_URL}/v2/financial_services/credit_bureau/credit_report/summary`,
        {
            method: 'POST',
            headers: kycHeaders(),
            body: JSON.stringify(cibilBody(params)),
        },
    );
    return res.json();
}

// ─── RC (Vehicle) to Chassis ──────────────────────────────────────────────────

export async function verifyRcNumber(rcNumber: string) {
    const res = await fetch(`${BASE_URL}/kyc/public_registry/validate`, {
        method: 'POST',
        headers: kycHeaders(),
        body: JSON.stringify({
            reference_id: genRefId(),
            document_type: 'RC',
            id_number: rcNumber,
            consent: 'Y',
            consent_purpose: 'Vehicle registration verification for loan processing',
        }),
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
    const form = new FormData();
    form.append('reference_id', genRefId());
    form.append('consent', 'Y');
    form.append('consent_purpose', 'Document classification for KYC verification');
    form.append('document', documentBlob, filename);

    const headers: Record<string, string> = {
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
    };
    if (isRealSecret(MODULE_SECRET_KYC)) headers['module_secret'] = MODULE_SECRET_KYC!;

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

export type OcrDocType = 'PAN' | 'AADHAAR' | 'DRIVING_LICENSE' | 'VOTERID';

export async function extractDocumentOcr(document_type: OcrDocType, documentBlob: Blob, filename: string) {
    const form = new FormData();
    form.append('reference_id', genRefId());
    form.append('document_type', document_type.toLowerCase());
    form.append('consent', 'Y');
    form.append('consent_purpose', 'for bank account purpose only');
    form.append('document', documentBlob, filename);

    const headers: Record<string, string> = {
        'client_id': CLIENT_ID,
        'client_secret': CLIENT_SECRET,
    };
    if (isRealSecret(MODULE_SECRET_KYC)) headers['module_secret'] = MODULE_SECRET_KYC!;

    const res = await fetch(`${BASE_URL}/kyc/scan_extract/ocr`, {
        method: 'POST',
        headers,
        body: form,
    });
    return res.json();
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

export function stringSimilarity(a: string, b: string): number {
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

export function normalizeDate(dateStr: string): string {
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


