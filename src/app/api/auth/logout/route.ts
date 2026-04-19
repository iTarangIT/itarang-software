import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export const runtime = 'nodejs';

// Fast logout: just delete every sb-* cookie on the response and redirect.
// We skip calling Supabase's /auth/v1/logout because the refresh token expires
// on its own, and we'd rather not add 500-1500 ms of network latency to the
// click. Middleware sees no auth cookie → user lands on /login.
async function handleLogout(request: Request) {
    const url = new URL(request.url);
    const response = NextResponse.redirect(new URL('/login', url), { status: 303 });

    const cookieStore = await cookies();
    for (const cookie of cookieStore.getAll()) {
        if (cookie.name.startsWith('sb-')) {
            response.cookies.set(cookie.name, '', {
                path: '/',
                maxAge: 0,
                expires: new Date(0),
            });
        }
    }

    return response;
}

export const GET = handleLogout;
export const POST = handleLogout;
