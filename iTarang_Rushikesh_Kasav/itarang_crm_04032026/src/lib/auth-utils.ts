import { db } from './db';
import { users } from './db/schema';
import { eq } from 'drizzle-orm';
import { createClient } from './supabase/server';
import { redirect } from 'next/navigation';

export async function requireAuth() {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
        redirect('/login');
    }

    // Fetch user from public.users table to get their role
    try {
        const dbUsers = await db.select()
            .from(users)
            .where(eq(users.id, user.id))
            .limit(1);

        const dbUser = dbUsers[0];

        if (!dbUser) {
            console.log(`[Auth] No DB user found for ID: ${user.id}`);
            // Fallback for new users or sync issues
            return {
                id: user.id,
                name: user.email?.split('@')[0] || 'User',
                email: user.email || '',
                role: 'user', // Default low-privilege role
                dealer_id: null,
            };
        }

        return dbUser;
    } catch (dbErr) {
        console.error('[Auth] Database error in requireAuth:', dbErr);
        throw dbErr;
    }
}

export async function requireRole(roles: string[]) {
    const user = await requireAuth();
    if (!roles.includes(user.role)) {
        throw new Error('Forbidden: Insufficient permissions');
    }
    return user;
}
