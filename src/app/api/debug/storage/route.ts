
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import { isS3Backend } from '@/lib/storage/s3';
import { requireDebugAccess } from '@/lib/auth/requireDebugAccess';

// Reveals the active storage backend, bucket name and a sample of stored
// filenames. 404s in production and without an admin/IT session.
export async function GET() {
    const access = await requireDebugAccess();
    if (!access.ok) return access.response;

    try {
        if (isS3Backend) {
            // No S3 equivalent of listBuckets() in our storage abstraction — return
            // a simple note identifying the active backend + physical bucket.
            return NextResponse.json({ backend: 's3', bucket: process.env.AWS_S3_BUCKET });
        }

        console.log('GET /api/debug/storage: Checking Supabase connection...');
        const supabase = await createClient();

        console.log('Listing storage buckets...');
        const { data: buckets, error: bucketError } = await supabase.storage.listBuckets();

        if (bucketError) {
            console.error('Bucket Error:', bucketError);
            return NextResponse.json({
                success: false,
                message: `Failed to list buckets: ${bucketError.message}`,
                error: bucketError
            }, { status: 500 });
        }

        const documentsBucket = buckets?.find(b => b.name === 'documents');

        console.log('Buckets found:', buckets?.map(b => b.name));

        if (!documentsBucket) {
            console.log('Bucket "documents" MISSING');
            return NextResponse.json({
                success: false,
                message: 'The "documents" storage bucket does not exist.',
                buckets: buckets?.map(b => b.name) || []
            }, { status: 404 });
        }

        console.log('Bucket "documents" EXISTS. Listing files...');

        // List specific bucket files to enable read check
        const { data: files, error: listError } = await supabase.storage.from('documents').list();

        if (listError) {
            console.error('List Files Error:', listError);
            return NextResponse.json({
                success: false,
                message: `Failed to list files in "documents": ${listError.message}`,
                bucketExists: true
            }, { status: 500 });
        }

        return NextResponse.json({
            success: true,
            bucketExists: true,
            filesCount: files?.length || 0,
            sampleFiles: files?.slice(0, 5).map(f => f.name) || []
        });

    } catch (error: any) {
        console.error('Debug API Critical Error:', error);
        return NextResponse.json({
            success: false,
            message: `Internal Server Error: ${error.message}`
        }, { status: 500 });
    }
}
