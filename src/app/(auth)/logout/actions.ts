
'use server';

import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

export async function signOut() {
    const supabase = await createClient();
    await supabase.auth.signOut();
    revalidatePath('/', 'layout');

    // Prefer the canonical deploy URL so stale tabs / proxy rewrites can't
    // send users to a dead host. next/navigation redirect() with an absolute
    // URL still works client-side.
    const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '');
    redirect(base ? `${base}/login` : '/login');
}
