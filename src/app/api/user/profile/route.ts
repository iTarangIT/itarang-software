import { after } from 'next/server';
import { requireAuthWithSupabaseUser } from '@/lib/auth-utils';
import { successResponse, withErrorHandler } from '@/lib/api-utils';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const GET = withErrorHandler(async () => {
    // One shared getUser() — requireAuthWithSupabaseUser returns both the RDS
    // profile and the Supabase auth user (with app_metadata) in a single pass.
    const { dbUser, authUser } = await requireAuthWithSupabaseUser();

    // Keep app_metadata.role (what the middleware reads) in sync with the RDS
    // role. Runs after the response is sent — the admin API write must not
    // gate the profile fetch that blocks every page's first paint.
    const currentRole = (authUser.app_metadata as { role?: string } | undefined)?.role;
    if (dbUser.role && currentRole !== dbUser.role) {
        after(async () => {
            try {
                await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
                    app_metadata: { ...(authUser.app_metadata ?? {}), role: dbUser.role },
                });
            } catch (err) {
                console.error('[profile] failed to sync app_metadata role:', err);
            }
        });
    }

    return successResponse(dbUser);
});
