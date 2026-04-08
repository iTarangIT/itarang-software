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
        const { pan_number, dob, document_type = 'PAN' } = await req.json();

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

        console.log('[Decentro PAN] Response:', JSON.stringify(decentroRes));

        const apiSuccess = (decentroRes.responseStatus || decentroRes.status || '').toUpperCase() === 'SUCCESS'
            || decentroRes.message?.toLowerCase().includes('retrieved successfully');

        const kycResult = decentroRes.kycResult || decentroRes.data?.kycResult || decentroRes.data || {};
        const panName = kycResult.name || '';
        const panStatus = (kycResult.idStatus || '').toUpperCase();
        const isPanValid = panStatus === 'VALID' || panStatus === 'ACTIVE';

        // Build verification result
        const reasons: string[] = [];
        let overallSuccess = apiSuccess;

        if (!apiSuccess) {
            reasons.push(`API error: ${decentroRes.message || 'Unknown error'}`);
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

        const verRecord = {
            status: verificationStatus,
            api_provider: 'decentro' as const,
            api_request: { pan_number, document_type },
            api_response: decentroRes,
            failed_reason: failedReason,
            match_score: matchScore !== null ? matchScore.toString() : null,
            completed_at: now,
            updated_at: now,
        };

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

        // Build response message
        let message = decentroRes.message || '';
        if (overallSuccess) {
            message = isPanValid ? `PAN verified. Name: ${panName}` : message;
            if (matchScore !== null && matchScore >= 50) {
                message += ` (${matchScore}% name match with lead)`;
            }
        } else {
            message = reasons.join('. ');
        }

        // Build BRD cross-match fields
        const leadDob = pd?.dob ? new Date(pd.dob).toISOString().slice(0, 10) : (lead.dob ? new Date(lead.dob).toISOString().slice(0, 10) : '');
        const leadAddress = pd?.local_address || lead.local_address || lead.current_address || '';
        const leadPhone = lead.phone || lead.mobile || '';
        const leadGender = ''; // gender from lead if available
        const leadAadhaar = pd?.aadhaar_no || '';

        const apiGender = kycResult.gender || '';
        const apiDob = kycResult.dateOfBirth || kycResult.dob || '';
        const apiAddress = kycResult.address?.full || kycResult.address || '';
        const apiMobile = kycResult.mobile || kycResult.phone || '';
        const apiAadhaar = kycResult.maskedAadhaar || kycResult.aadhaar || '';

        const crossMatchFields = [
            {
                field: 'PAN Status',
                leadValue: 'Active',
                apiValue: kycResult.idStatus || kycResult.panStatus || null,
                matchScore: (kycResult.idStatus || '').toUpperCase() === 'VALID' ? 100 : 0,
                pass: isPanValid,
            },
            {
                field: 'PAN Type',
                leadValue: 'Personal',
                apiValue: kycResult.category || null,
                matchScore: (kycResult.category || '').toLowerCase() === 'person' || (kycResult.category || '').toLowerCase() === 'individual' ? 100 : 0,
                pass: true,
            },
            {
                field: 'Name',
                leadValue: leadName,
                apiValue: panName,
                matchScore: matchScore ?? 0,
                pass: (matchScore ?? 0) >= 80,
            },
            {
                field: 'Gender',
                leadValue: leadGender || null,
                apiValue: apiGender || null,
                matchScore: !leadGender || !apiGender ? null : (leadGender.charAt(0).toUpperCase() === apiGender.charAt(0).toUpperCase() ? 100 : 0),
                pass: !leadGender || !apiGender ? true : leadGender.charAt(0).toUpperCase() === apiGender.charAt(0).toUpperCase(),
            },
            {
                field: 'DOB',
                leadValue: leadDob || null,
                apiValue: apiDob || null,
                matchScore: !leadDob || !apiDob ? null : (leadDob === apiDob ? 100 : 0),
                pass: !leadDob || !apiDob ? true : leadDob === apiDob,
            },
            {
                field: 'Aadhaar',
                leadValue: leadAadhaar ? `XXXX${leadAadhaar.slice(-4)}` : null,
                apiValue: apiAadhaar || null,
                matchScore: !leadAadhaar || !apiAadhaar ? null : (leadAadhaar.slice(-4) === apiAadhaar.slice(-4) ? 100 : 0),
                pass: true,
            },
            {
                field: 'Address',
                leadValue: leadAddress || null,
                apiValue: typeof apiAddress === 'string' ? apiAddress : JSON.stringify(apiAddress) || null,
                matchScore: !leadAddress || !apiAddress ? null : nameSimilarity(leadAddress, typeof apiAddress === 'string' ? apiAddress : ''),
                pass: !leadAddress || !apiAddress ? true : nameSimilarity(leadAddress, typeof apiAddress === 'string' ? apiAddress : '') >= 80,
            },
            {
                field: 'Mobile',
                leadValue: leadPhone || null,
                apiValue: apiMobile || null,
                matchScore: !leadPhone || !apiMobile ? null : (leadPhone.slice(-10) === apiMobile.slice(-10) ? 100 : 0),
                pass: !leadPhone || !apiMobile ? true : leadPhone.slice(-10) === apiMobile.slice(-10),
            },
        ];

        return NextResponse.json({
            success: overallSuccess,
            message,
            data: {
                pan_name: panName,
                lead_name: leadName,
                pan_status: kycResult.idStatus || null,
                pan_category: kycResult.category || null,
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
