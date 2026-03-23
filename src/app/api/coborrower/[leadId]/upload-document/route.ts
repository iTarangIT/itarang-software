import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { coBorrowerDocuments, coBorrowers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { createClient } from '@/lib/supabase/server';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const formData = await req.formData();
        const file = formData.get('file') as File;
        const docType = formData.get('docType') as string;

        if (!file || !docType) {
            return NextResponse.json({ success: false, error: { message: 'File and docType required' } }, { status: 400 });
        }

        if (file.size > 5 * 1024 * 1024) {
            return NextResponse.json({ success: false, error: { message: 'File must be under 5MB' } }, { status: 400 });
        }

        // Get co-borrower ID
        const cob = await db.select().from(coBorrowers).where(eq(coBorrowers.lead_id, leadId)).limit(1);
        const coBorrowerId = cob[0]?.id;

        // Upload to storage
        const supabase = await createClient();
        const fileName = `kyc/${leadId}/coborrower/${docType}_${Date.now()}.${file.name.split('.').pop()}`;
        const buffer = Buffer.from(await file.arrayBuffer());

        const { error: uploadError } = await supabase.storage
            .from('documents')
            .upload(fileName, buffer, { contentType: file.type, upsert: true });

        if (uploadError) {
            return NextResponse.json({ success: false, error: { message: 'Upload failed' } }, { status: 500 });
        }

        const { data: urlData } = supabase.storage.from('documents').getPublicUrl(fileName);

        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const seq = Math.floor(Math.random() * 10000).toString().padStart(4, '0');

        await db.insert(coBorrowerDocuments).values({
            id: `COBDOC-${dateStr}-${seq}`,
            co_borrower_id: coBorrowerId || '',
            lead_id: leadId,
            doc_type: docType,
            file_url: urlData.publicUrl,
            file_name: file.name,
            file_size: file.size,
            verification_status: 'pending',
            uploaded_at: now,
            updated_at: now,
        });

        return NextResponse.json({ success: true, file_url: urlData.publicUrl });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
