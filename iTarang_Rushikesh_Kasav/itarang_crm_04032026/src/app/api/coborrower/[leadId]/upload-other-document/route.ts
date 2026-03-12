import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { otherDocumentRequests } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { createClient } from '@/lib/supabase/server';

export async function POST(req: NextRequest, { params }: { params: Promise<{ leadId: string }> }) {
    try {
        const { leadId } = await params;
        const formData = await req.formData();
        const file = formData.get('file') as File;
        const docKey = formData.get('docKey') as string;

        if (!file || !docKey) {
            return NextResponse.json({ success: false, error: { message: 'File and docKey required' } }, { status: 400 });
        }

        const supabase = await createClient();
        const fileName = `kyc/${leadId}/other/${docKey}_${Date.now()}.${file.name.split('.').pop()}`;
        const buffer = Buffer.from(await file.arrayBuffer());

        const { error: uploadError } = await supabase.storage
            .from('documents')
            .upload(fileName, buffer, { contentType: file.type, upsert: true });

        if (uploadError) {
            return NextResponse.json({ success: false, error: { message: 'Upload failed' } }, { status: 500 });
        }

        const { data: urlData } = supabase.storage.from('documents').getPublicUrl(fileName);

        await db.update(otherDocumentRequests)
            .set({
                file_url: urlData.publicUrl,
                upload_status: 'uploaded',
                uploaded_at: new Date(),
            })
            .where(and(
                eq(otherDocumentRequests.lead_id, leadId),
                eq(otherDocumentRequests.doc_key, docKey)
            ));

        return NextResponse.json({ success: true, file_url: urlData.publicUrl });
    } catch (error) {
        return NextResponse.json({ success: false, error: { message: 'Server error' } }, { status: 500 });
    }
}
