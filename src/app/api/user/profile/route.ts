import { after } from 'next/server';
import { requireAuthWithSupabaseUser } from '@/lib/auth-utils';
import { successResponse, withErrorHandler } from '@/lib/api-utils';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const GET = withErrorHandler(async () => {
    // One shared getUser() — requireAuthWithSupabaseUser returns both the RDS
    // profile and the Supabase auth user (with app_metadata) in a single pass.
    const { dbUser, authUser, synthesized } = await requireAuthWithSupabaseUser();

    // Keep app_metadata.role (what the middleware reads) in sync with the RDS
    // role. Runs after the response is sent — the admin API write must not
    // gate the profile fetch that blocks every page's first paint.
    //
    // ONLY when the row is real. When `synthesized` is set the DB had no row
    // for this auth user and `dbUser.role` is the literal placeholder "user".
    // Writing that into app_metadata is not a sync, it is a demotion: the
    // Supabase auth store is shared by database-1 and database-2, whose user
    // tables are almost disjoint, so an account that only exists in the OTHER
    // database would land here every time someone ran the app against this
    // one — and both middleware and getSessionUser() read app_metadata.role
    // before anything else, so the real role became unreachable from then on
    // ("FORBIDDEN: role=user cannot access NBFC routes" for a genuine
    // nbfc_partner). The placeholder is a fact about THIS database's rows,
    // not about the account, and it must not leave this process.
    const currentRole = (authUser.app_metadata as { role?: string } | undefined)?.role;
    if (!synthesized && dbUser.role && currentRole !== dbUser.role) {
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
