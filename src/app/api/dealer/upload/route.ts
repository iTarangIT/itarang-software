
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin'; // New Service Role Client
import { withErrorHandler, successResponse } from '@/lib/api-utils';
import { NextResponse } from 'next/server';
import { resolveDealerProfile } from '@/lib/supabase/identity';
import { isS3Backend, putObject, filesProxyPath } from '@/lib/storage/s3';

export const POST = withErrorHandler(async (req: Request) => {
    // 1. Initialize Standard Client for Auth
    const supabase = await createClient();

    // 2. Authenticate & Verify Dealer
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        console.error('Upload Auth Error:', authError);
        return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
    }

    const profile = await resolveDealerProfile(supabase, user, 'id,email,role,dealer_id');

    if (!profile) {
        console.error('Upload Profile Error: dealer profile not found for authenticated user');
        return NextResponse.json({ success: false, message: 'Access denied: Dealer account required' }, { status: 403 });
    }

    // 3. Parse Form Data
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const documentType = formData.get('documentType') as string;

    if (!file) {
        return NextResponse.json({ success: false, message: 'No file provided' }, { status: 400 });
    }

    // 5. Build storage path
    const bucketName = 'documents';
    const fileExt = file.name.split('.').pop();
    const fileName = `${profile.dealer_id}/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;

    let publicUrl: string;
    let uploadedPath: string;

    if (isS3Backend) {
        // S3 buckets are provisioned out-of-band — skip the listBuckets/createBucket
        // auto-provision dance entirely and just upload.
        console.log(`Uploading file ${fileName} to S3 bucket ${bucketName}...`);
        const buffer = Buffer.from(await file.arrayBuffer());
        await putObject(bucketName, fileName, buffer, file.type, { cacheControl: '3600' });
        uploadedPath = fileName;
        publicUrl = filesProxyPath(bucketName, fileName);
    } else {
        // 4. Initialize Admin Client for Storage Operations (Bypassing RLS)
        console.log('Using admin Supabase client for storage operations...');
        const adminSupabase = createAdminClient();

        // 5. Ensure Bucket Exists
        const { data: buckets, error: bucketError } = await adminSupabase.storage.listBuckets();

        if (bucketError) {
            console.error('Bucket List Error:', bucketError);
            // Fallback or error? Let's error for now to be safe, but generic listing fail shouldn't block if we know bucket name
            return NextResponse.json({ success: false, message: 'Storage configuration error' }, { status: 500 });
        }

        if (!buckets?.find((b: { name: string }) => b.name === bucketName)) {
            console.log(`Creating bucket: ${bucketName}`);
            const { error: createError } = await adminSupabase.storage.createBucket(bucketName, {
                public: true, // Set to true since we use getPublicUrl later
                fileSizeLimit: 5242880, // 5MB limit example
                allowedMimeTypes: ['image/png', 'image/jpeg', 'application/pdf']
            });

            if (createError) {
                console.error('Bucket Create Error:', createError);
                return NextResponse.json({ success: false, message: `Failed to create storage bucket: ${createError.message}` }, { status: 500 });
            }
        }
        console.log('Bucket check passed');

        // 6. Upload File
        console.log(`Uploading file ${fileName} to bucket ${bucketName}...`);

        const { data, error } = await adminSupabase.storage
            .from(bucketName)
            .upload(fileName, file, {
                cacheControl: '3600',
                upsert: false,
                contentType: file.type // Pass content type explicitly
            });

        if (error) {
            console.error('Upload Failed:', error);
            return NextResponse.json({ success: false, message: error.message }, { status: 500 });
        }

        console.log('Upload successful:', data);

        // 7. Get Public URL (Check if we need admin client here too? Usually standard client is fine for getPublicUrl if bucket is public)
        const { data: { publicUrl: supabasePublicUrl } } = adminSupabase.storage.from(bucketName).getPublicUrl(fileName);
        uploadedPath = data.path;
        publicUrl = supabasePublicUrl;
    }

    return successResponse({
        url: publicUrl,
        path: uploadedPath,
        documentType
    });
});
