import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import crypto from 'crypto';
import { sanitizeDbError } from '@/lib/error-utils';

export function successResponse(data: any, status = 200) {
    return NextResponse.json({
        success: true,
        data,
        timestamp: new Date().toISOString()
    }, { status });
}

export function errorResponse(message: string, status = 500) {
    return NextResponse.json({
        success: false,
        error: { message },
        timestamp: new Date().toISOString()
    }, { status });
}

export function withErrorHandler(handler: Function) {
    return async (req: Request, context?: any) => {
        try {
            return await handler(req, context);
        } catch (error: any) {
            // Re-throw Next.js redirect errors
            if (error.digest?.startsWith('NEXT_REDIRECT')) {
                throw error;
            }

            console.error('API Error:', error);
            if (error instanceof ZodError) {
                return NextResponse.json({
                    success: false,
                    error: {
                        message: 'Validation failed',
                        details: error.issues.map(i => ({
                            path: i.path.join('.'),
                            message: i.message
                        }))
                    },
                    timestamp: new Date().toISOString()
                }, { status: 400 });
            }
            return errorResponse(sanitizeDbError(error) || 'Internal error', 500);
        }
    };
}

/** True for Next.js redirect/notFound control-flow errors that must be re-thrown. */
export function isNextRedirectError(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        typeof (error as { digest?: unknown }).digest === 'string' &&
        (error as { digest: string }).digest.startsWith('NEXT_REDIRECT')
    );
}

/** Safely extract a message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function generateId(prefix: string, _table?: any): Promise<string> {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const rand = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    return `${prefix}-${date}-${rand}`;
}

