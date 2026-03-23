import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
    const checks: Record<string, any> = {};

    // 1. Check DATABASE_URL exists
    const dbUrl = process.env.DATABASE_URL;
    checks.DATABASE_URL_SET = !!dbUrl;
    if (dbUrl) {
        try {
            const parsed = new URL(dbUrl);
            checks.DB_HOST = parsed.hostname;
            checks.DB_PORT = parsed.port;
            checks.DB_USER = parsed.username;
            checks.DB_NAME = parsed.pathname;
            checks.DB_PASSWORD_LENGTH = decodeURIComponent(parsed.password).length;
        } catch (e: any) {
            checks.DB_URL_PARSE_ERROR = e.message;
        }
    }

    // 2. Check Supabase env vars
    checks.SUPABASE_URL_SET = !!process.env.NEXT_PUBLIC_SUPABASE_URL;
    checks.SUPABASE_ANON_KEY_SET = !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    checks.SERVICE_ROLE_KEY_SET = !!process.env.SUPABASE_SERVICE_ROLE_KEY;

    // 3. Test actual DB connection
    try {
        const postgres = (await import('postgres')).default;
        const sql = postgres(dbUrl!, { ssl: 'require', prepare: false, connect_timeout: 5 });
        const result = await sql`SELECT count(*) as cnt FROM users`;
        checks.DB_CONNECTION = 'OK';
        checks.DB_USER_COUNT = result[0]?.cnt;
        await sql.end();
    } catch (e: any) {
        checks.DB_CONNECTION = 'FAILED';
        checks.DB_ERROR = e.message;
        checks.DB_ERROR_CODE = e.code;
    }

    return NextResponse.json(checks);
}
