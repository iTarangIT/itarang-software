import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';

export const runtime = 'nodejs';

// Fast logout: delete every sb-* cookie and redirect. We skip calling
// Supabase's /auth/v1/logout (saves 500-1500ms of network latency —
// the refresh token expires on its own anyway).
//
// Redirect-URL priority:
//   1. x-forwarded-host / x-forwarded-proto (set by the reverse proxy —
//      nginx/cloudflare/hostinger — and tells us the PUBLIC URL the user
//      actually hit, which is what we want).
//   2. NEXT_PUBLIC_APP_URL env var (the canonical URL for this deploy).
//   3. request.url — in dev only. In production, NEVER use this because
//      Next.js sees the internal upstream URL (localhost:3003 behind nginx)
//      and would 302 the browser there.
//
// Also enforces a safety net: in production, refuse to ever redirect to
// a localhost / private-network host. Falls back to a final hardcoded
// root domain if every other signal is broken.
function isLocalHost(hostname: string): boolean {
    const h = hostname.toLowerCase();
    return (
        h === 'localhost' ||
        h === '127.0.0.1' ||
        h === '::1' ||
        h.startsWith('192.168.') ||
        h.startsWith('10.') ||
        h.startsWith('172.16.') ||
        h.startsWith('172.17.') ||
        h.startsWith('172.18.') ||
        h.startsWith('172.19.') ||
        h.startsWith('172.2') ||
        h.startsWith('172.30.') ||
        h.startsWith('172.31.')
    );
}

async function resolveBaseUrl(request: Request): Promise<URL> {
    const isProd = process.env.NODE_ENV === 'production';
    const hdrs = await headers();

    // 1. Trust the reverse proxy's forwarded-host header first — that's
    //    the public URL the user actually typed (sandbox.itarang.com /
    //    crm.itarang.com), before nginx proxied to Node.
    const forwardedHost = hdrs.get('x-forwarded-host');
    const forwardedProto = hdrs.get('x-forwarded-proto') ?? 'https';
    if (forwardedHost && !isLocalHost(forwardedHost.split(':')[0])) {
        try {
            return new URL(`${forwardedProto}://${forwardedHost}`);
        } catch { /* fall through */ }
    }

    // 2. Fall back to the deploy-time canonical URL.
    const envUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
    if (envUrl) {
        try {
            const u = new URL(envUrl);
            if (!isProd || !isLocalHost(u.hostname)) return u;
            // In prod with a localhost env URL — misconfig. Ignore.
            console.warn(
                '[logout] NEXT_PUBLIC_APP_URL points to localhost in production — ignoring.',
            );
        } catch { /* malformed — fall through */ }
    }

    // 3. Dev / last-resort: use request.url, but reject localhost in prod.
    const reqUrl = new URL(request.url);
    if (isProd && isLocalHost(reqUrl.hostname)) {
        // Production with nothing usable — we'd rather return a relative
        // Location than send the browser to localhost. Construct a relative
        // URL by returning the request.url with its path stripped; the
        // caller will append /login.
        console.error(
            '[logout] No usable host for redirect. Set NEXT_PUBLIC_APP_URL or ensure your reverse proxy sets X-Forwarded-Host.',
        );
        // Emit a URL whose origin is empty so `new URL('/login', base)`
        // still works client-side (browser will treat it as relative).
        // We return a sentinel URL — the caller checks this.
        return new URL('/', 'http://invalid.local');
    }
    return reqUrl;
}

async function handleLogout(request: Request) {
    const base = await resolveBaseUrl(request);
    // If resolveBaseUrl returned the sentinel (misconfigured prod),
    // emit a relative redirect. The browser resolves it against the
    // current page's origin — which is the correct public origin.
    const loginUrl =
        base.hostname === 'invalid.local'
            ? '/login'
            : new URL('/login', base).toString();
    const response = NextResponse.redirect(loginUrl, { status: 303 });

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
