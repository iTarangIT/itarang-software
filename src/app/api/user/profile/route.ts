import { requireAuth } from '@/lib/auth-utils';
import { successResponse, withErrorHandler } from '@/lib/api-utils';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';

export const GET = withErrorHandler(async (req: Request) => {
    const user = await requireAuth();

    try {
        const supabase = await createClient();
        const { data: { user: authUser } } = await supabase.auth.getUser();
        const currentRole = (authUser?.app_metadata as { role?: string } | undefined)?.role;
        if (authUser && user.role && currentRole !== user.role) {
            await supabaseAdmin.auth.admin.updateUserById(authUser.id, {
                app_metadata: { ...(authUser.app_metadata ?? {}), role: user.role },
            });
        }
    } catch (err) {
        console.error('[profile] failed to sync app_metadata role:', err);
    }

    return successResponse(user);
});
