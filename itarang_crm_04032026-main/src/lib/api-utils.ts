import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { db } from './db';
import { sql, eq, desc } from 'drizzle-orm';

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
            return errorResponse(error.message || 'Internal error', 500);
        }
    };
}

export async function generateId(prefix: string, table: any): Promise<string> {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');

    // Find the last ID for this prefix and date
    const lastRecord = await db.select({ id: table.id })
        .from(table)
        .where(sql`${table.id} LIKE ${prefix + '-' + date + '-%'}`)
        .orderBy(desc(table.id))
        .limit(1);

    let sequence = 1;
    if (lastRecord.length > 0) {
        const lastId = lastRecord[0].id;
        const lastSeq = parseInt(lastId.split('-').pop() || '0');
        sequence = lastSeq + 1;
    }

    return `${prefix}-${date}-${sequence.toString().padStart(3, '0')}`;
}

export async function generateLeadReference(table: any): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `#IT-${year}`;

    const lastRecord = await db.select({ reference_id: table.reference_id })
        .from(table)
        .where(sql`${table.reference_id} LIKE ${prefix + '-%'}`)
        .orderBy(desc(table.reference_id))
        .limit(1);

    let sequence = 1;
    if (lastRecord.length > 0 && lastRecord[0].reference_id) {
        const lastRef = lastRecord[0].reference_id;
        const lastSeq = parseInt(lastRef.split('-').pop() || '0');
        sequence = lastSeq + 1;
    }

    return `${prefix}-${sequence.toString().padStart(5, '0')}`;
}
