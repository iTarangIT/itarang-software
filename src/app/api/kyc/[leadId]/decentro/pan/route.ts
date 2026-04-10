import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { db } from '@/lib/db';
import { kycVerifications, leads, personalDetails } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { validateDocument } from '@/lib/decentro';

// Simple name similarity check (normalized Jaccard on words)
function nameSimilarity(a: string, b: string): number {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
    const wordsA = new Set(normalize(a));
    const wordsB = new Set(normalize(b));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
    const union = new Set([...wordsA, ...wordsB]).size;
    return Math.round((intersection / union) * 100);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const supabase = await createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

        const { leadId } = await params;
        const { pan_number, dob, document_type = 'PAN_DETAILED_COMPLETE' } = await req.json();

        if (!pan_number) {
            return NextResponse.json({ success: false, error: 'PAN number is required' }, { status: 400 });
        }

        // Fetch lead + personal details to compare fields
        const [leadRows, pdRows] = await Promise.all([
            db.select({
                full_name: leads.full_name,
                owner_name: leads.owner_name,
                phone: leads.phone,
                mobile: leads.mobile,
                dob: leads.dob,
                current_address: leads.current_address,
                local_address: leads.local_address,
            }).from(leads).where(eq(leads.id, leadId)).limit(1),
            db.select({
                pan_no: personalDetails.pan_no,
                aadhaar_no: personalDetails.aadhaar_no,
                dob: personalDetails.dob,
                local_address: personalDetails.local_address,
                father_husband_name: personalDetails.father_husband_name,
            }).from(personalDetails).where(eq(personalDetails.lead_id, leadId)).limit(1),
        ]);
        const lead = leadRows[0];
        const pd = pdRows[0];
        if (!lead) {
            return NextResponse.json({ success: false, error: 'Lead not found' }, { status: 404 });
        }

        // Call Decentro API (DOB not required for PAN validation)
        const decentroRes = await validateDocument({
            document_type,
            id_number: pan_number.toUpperCase().trim(),
        });

        console.log('[Decentro PAN] document_type:', document_type, '| response:', JSON.stringify(decentroRes).slice(0, 500));

        // message can be a string or an object — normalize to string
        const decentroMessage = typeof decentroRes.message === 'string'
            ? decentroRes.message
            : (decentroRes.message?.message || decentroRes.error?.message || '');

        const apiSuccess = (decentroRes.responseStatus || decentroRes.status || '').toUpperCase() === 'SUCCESS'
            || decentroMessage.toLowerCase().includes('retrieved successfully')
            || decentroMessage.toLowerCase().includes('fetched successfully');

        // PAN_DETAILED: kycResult is at top level. PAN basic: may be under data.kycResult
        const kycResult = decentroRes.kycResult || decentroRes.data?.kycResult || decentroRes.data || {};

        // Extract name — PAN_DETAILED uses fullName / firstName+lastName, basic PAN uses name
        const panName = kycResult.fullName
            || [kycResult.firstName, kycResult.middleName, kycResult.lastName].filter(Boolean).join(' ')
            || kycResult.name || '';

        // Extract status — PAN_DETAILED has both idStatus and panStatus
        const panStatus = (kycResult.idStatus || kycResult.panStatus || kycResult.status || '').toUpperCase();
        const isPanValid = panStatus === 'VALID' || panStatus === 'ACTIVE';

        // Build verification result
        const reasons: string[] = [];
        let overallSuccess = apiSuccess;

        if (!apiSuccess) {
            reasons.push(`API error: ${decentroMessage || decentroRes.responseMessage || JSON.stringify(decentroRes).slice(0, 200)}`);
            overallSuccess = false;
        } else if (!isPanValid) {
            reasons.push(`PAN status: ${kycResult.idStatus || 'UNKNOWN'} (not valid)`);
            overallSuccess = false;
        }

        // Name comparison
        let matchScore: number | null = null;
        const leadName = lead.full_name || '';
        if (panName && leadName) {
            matchScore = nameSimilarity(panName, leadName);
            if (matchScore < 50) {
                reasons.push(`Name mismatch: PAN name "${panName}" does not match lead name "${leadName}" (${matchScore}% match)`);
                overallSuccess = false;
            } else if (matchScore < 80) {
                reasons.push(`Partial name match: PAN "${panName}" vs lead "${leadName}" (${matchScore}% match)`);
                // Partial match — still pass but flag it
            }
        } else if (!leadName) {
            reasons.push('Lead name not available for comparison');
        }

        const failedReason = reasons.length > 0 ? reasons.join('; ') : null;
        const verificationStatus = overallSuccess ? 'success' : 'failed';
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');

        // Build BRD cross-match fields: Name, Gender, DOB, Address, Mobile
        // Each field has leadValue, panValue, aadhaarValue (aadhaar filled later via DigiLocker)
        const leadDob = pd?.dob ? new Date(pd.dob).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
            : (lead.dob ? new Date(lead.dob).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
        const leadAddress = pd?.local_address || lead.local_address || lead.current_address || '';
        const leadPhone = lead.phone || lead.mobile || '';
        const leadGender = ''; // gender from lead if available

        const panGender = kycResult.gender || '';
        const panDob = kycResult.dateOfBirth || kycResult.dob || '';
        const panAddress = kycResult.address?.full || (typeof kycResult.address === 'string' ? kycResult.address : '') || '';
        const panMobile = kycResult.mobile || kycResult.phone || '';

        function computeMatch(a: string, b: string, type: 'similarity' | 'exact' | 'phone' = 'similarity'): { score: number | null; pass: boolean } {
            if (!a || !b) return { score: null, pass: true };
            if (type === 'exact') {
                const match = a.trim().toLowerCase() === b.trim().toLowerCase();
                return { score: match ? 100 : 0, pass: match };
            }
            if (type === 'phone') {
                const match = a.replace(/\D/g, '').slice(-10) === b.replace(/\D/g, '').slice(-10);
                return { score: match ? 100 : 0, pass: match };
            }
            const sim = nameSimilarity(a, b);
            return { score: sim, pass: sim >= 80 };
        }

        const nameMatch = computeMatch(leadName, panName);
        const genderMatch = computeMatch(leadGender, panGender, 'exact');
        const dobMatch = computeMatch(leadDob, panDob, 'exact');
        const addressMatch = computeMatch(leadAddress, typeof panAddress === 'string' ? panAddress : '');
        const mobileMatch = computeMatch(leadPhone, panMobile, 'phone');

        const allCrossMatchFields = [
            { field: 'Name', leadValue: leadName || null, panValue: panName || null, aadhaarValue: null, matchScore: nameMatch.score, pass: nameMatch.pass },
            { field: 'Gender', leadValue: leadGender || null, panValue: panGender || null, aadhaarValue: null, matchScore: genderMatch.score, pass: genderMatch.pass },
            { field: 'DOB', leadValue: leadDob || null, panValue: panDob || null, aadhaarValue: null, matchScore: dobMatch.score, pass: dobMatch.pass },
            { field: 'Address', leadValue: leadAddress || null, panValue: typeof panAddress === 'string' ? panAddress : JSON.stringify(panAddress) || null, aadhaarValue: null, matchScore: addressMatch.score, pass: addressMatch.pass },
            { field: 'Mobile', leadValue: leadPhone || null, panValue: panMobile || null, aadhaarValue: null, matchScore: mobileMatch.score, pass: mobileMatch.pass },
        ];

        const crossMatchFields = allCrossMatchFields.filter(f => f.leadValue || f.panValue);

        // Build response message
        let message = decentroMessage || '';
        if (overallSuccess) {
            message = isPanValid ? `PAN verified. Name: ${panName}` : message;
            if (matchScore !== null && matchScore >= 50) {
                message += ` (${matchScore}% name match with lead)`;
            }
        } else {
            message = reasons.join('. ');
        }

        const verRecord = {
            status: verificationStatus,
            api_provider: 'decentro' as const,
            api_request: { pan_number, document_type },
            api_response: {
                ...decentroRes,
                message,
                data: {
                    crossMatchFields,
                    pan_name: panName,
                    lead_name: leadName,
                    pan_status: kycResult.idStatus || kycResult.panStatus || null,
                    name_match_score: matchScore,
                },
            },
            failed_reason: failedReason,
            match_score: matchScore !== null ? matchScore.toString() : null,
            completed_at: now,
            updated_at: now,
        };

        // Save PAN number to personalDetails so it persists and auto-populates everywhere (CIBIL, etc.)
        const panUpper = pan_number.toUpperCase().trim();
        if (pd) {
            await db.update(personalDetails).set({ pan_no: panUpper })
                .where(eq(personalDetails.lead_id, leadId));
        } else {
            await db.insert(personalDetails).values({
                lead_id: leadId,
                pan_no: panUpper,
            });
        }

        // Upsert kycVerification record
        const existing = await db.select({ id: kycVerifications.id })
            .from(kycVerifications)
            .where(and(eq(kycVerifications.lead_id, leadId), eq(kycVerifications.verification_type, 'pan')))
            .limit(1);

        if (existing.length > 0) {
            await db.update(kycVerifications).set(verRecord)
                .where(and(eq(kycVerifications.lead_id, leadId), eq(kycVerifications.verification_type, 'pan')));
        } else {
            await db.insert(kycVerifications).values({
                id: `KYCVER-${dateStr}-${seq}`,
                lead_id: leadId,
                verification_type: 'pan',
                submitted_at: now,
                created_at: now,
                ...verRecord,
            });
        }

        return NextResponse.json({
            success: overallSuccess,
            message,
            data: {
                pan_name: panName,
                lead_name: leadName,
                pan_status: kycResult.idStatus || kycResult.panStatus || null,
                pan_category: kycResult.category || null,
                pan_type: kycResult.panType || null,
                email: kycResult.email || null,
                aadhaar_seeding: kycResult.aadhaarSeedingStatus || null,
                masked_aadhaar: kycResult.maskedAadhaar || null,
                father_name: kycResult.fatherName || null,
                name_match_score: matchScore,
                crossMatchFields,
            },
            decentroTxnId: decentroRes.decentroTxnId,
        });
    } catch (error) {
        console.error('Decentro PAN verification error:', error);
        return NextResponse.json({ success: false, error: 'Server error' }, { status: 500 });
    }
}
