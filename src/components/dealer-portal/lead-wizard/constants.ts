export const FINANCE_DOCUMENTS = [
    { key: 'aadhaar_front', label: 'Aadhaar Front', required: true },
    { key: 'aadhaar_back', label: 'Aadhaar Back', required: true },
    { key: 'pan_card', label: 'PAN Card', required: true },
    { key: 'passport_photo', label: 'Passport Size Photo', required: true },
    { key: 'address_proof', label: 'Address Proof', required: true },
    { key: 'rc_copy', label: 'RC Copy', required: false, conditional: true },
    { key: 'bank_statement', label: 'Bank Statement', required: false },
    { key: 'cheque_1', label: 'Undated Cheque 1', required: true },
    { key: 'cheque_2', label: 'Undated Cheque 2', required: true },
    { key: 'cheque_3', label: 'Undated Cheque 3', required: true },
    { key: 'cheque_4', label: 'Undated Cheque 4', required: true },
] as const;

export const CO_BORROWER_DOCS = [
    { key: 'aadhaar_front', label: 'Aadhaar Front', required: true },
    { key: 'aadhaar_back', label: 'Aadhaar Back', required: true },
    { key: 'pan_card', label: 'PAN Card', required: true },
    { key: 'passport_photo', label: 'Passport Photo', required: true },
    { key: 'address_proof', label: 'Address Proof', required: false },
    { key: 'bank_statement', label: 'Bank Statement', required: false },
    { key: 'cheque_1', label: 'Undated Cheque 1', required: false },
    { key: 'cheque_2', label: 'Undated Cheque 2', required: false },
    { key: 'cheque_3', label: 'Undated Cheque 3', required: false },
    { key: 'cheque_4', label: 'Undated Cheque 4', required: false },
    { key: 'rc_copy', label: 'RC Copy', required: false },
] as const;

export const UPFRONT_DOCUMENTS = [
    { key: 'aadhaar_front', label: 'Aadhaar Front', required: true },
    { key: 'aadhaar_back', label: 'Aadhaar Back', required: true },
    { key: 'pan_card', label: 'PAN Card', required: true },
] as const;

export const INTEREST_LEVELS = [
    { value: 'hot', label: 'Hot', score: 90 },
    { value: 'warm', label: 'Warm', score: 60 },
    { value: 'cold', label: 'Cold', score: 30 },
] as const;

export const PAYMENT_METHODS = [
    { value: 'other_finance', label: 'Other Finance' },
    { value: 'cash', label: 'Cash' },
    { value: 'dealer_finance', label: 'Dealer Finance' },
] as const;

export const VEHICLE_OWNERSHIP_OPTIONS = [
    { value: 'self', label: 'Self' },
    { value: 'financed', label: 'Financed' },
    { value: 'company', label: 'Company' },
    { value: 'leased', label: 'Leased' },
    { value: 'family', label: 'Family' },
] as const;

export const VEHICLE_CATEGORIES = ['2W', '3W', '4W', '2-Wheeler', '3-Wheeler', '4-Wheeler'];

export function isFinanceMethod(method: string | null | undefined): boolean {
    return ['finance', 'other_finance', 'dealer_finance'].includes(method || '');
}

export function isCashMethod(method: string | null | undefined): boolean {
    return method === 'cash' || method === 'upfront';
}
