
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin'; // New Service Role Client
import { withErrorHandler, successResponse } from '@/lib/api-utils';
import { NextResponse } from 'next/server';

export const POST = withErrorHandler(async (req: Request) => {
    // 1. Initialize Standard Client for Auth
    const supabase = await createClient();

    // 2. Authenticate & Verify Dealer
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        console.error('Upload Auth Error:', authError);
        return NextResponse.json({ success: false, message: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile, error: profileError } = await supabase
        .from('users')
        .select('role, dealer_id')
        .eq('id', user.id)
        .single();

    if (profileError || profile?.role !== 'dealer' || !profile?.dealer_id) {
        console.error('Upload Profile Error:', profileError);
        return NextResponse.json({ success: false, message: 'Access denied: Dealer account required' }, { status: 403 });
    }

    // 3. Parse Form Data
    const formData = await req.formData();
    const file = formData.get('file') as File;
    const documentType = formData.get('documentType') as string;

    if (!file) {
        return NextResponse.json({ success: false, message: 'No file provided' }, { status: 400 });
    }

    // 4. Initialize Admin Client for Storage Operations (Bypassing RLS)
    console.log('Using admin Supabase client for storage operations...');
    const adminSupabase = createAdminClient();

    // 5. Ensure Bucket Exists
    const bucketName = 'documents';
    const { data: buckets, error: bucketError } = await adminSupabase.storage.listBuckets();

    if (bucketError) {
        console.error('Bucket List Error:', bucketError);
        // Fallback or error? Let's error for now to be safe, but generic listing fail shouldn't block if we know bucket name
        return NextResponse.json({ success: false, message: 'Storage configuration error' }, { status: 500 });
    }

    if (!buckets?.find(b => b.name === bucketName)) {
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
    const fileExt = file.name.split('.').pop();
    const fileName = `${profile.dealer_id}/${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;

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
    const { data: { publicUrl } } = adminSupabase.storage.from(bucketName).getPublicUrl(fileName);

    return successResponse({
        url: publicUrl,
        path: data.path,
        documentType
    });
});
