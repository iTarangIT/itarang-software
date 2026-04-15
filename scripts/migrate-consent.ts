import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { sql } from 'drizzle-orm';

async function migrate() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const db = drizzle(pool);

    try {
        console.log('Adding columns to consent_records...');
        await db.execute(sql`
            ALTER TABLE consent_records
            ADD COLUMN IF NOT EXISTS consent_link_expires_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS consent_delivery_channel VARCHAR(20),
            ADD COLUMN IF NOT EXISTS sign_method VARCHAR(30),
            ADD COLUMN IF NOT EXISTS esign_transaction_id VARCHAR(255),
            ADD COLUMN IF NOT EXISTS esign_certificate_id VARCHAR(255),
            ADD COLUMN IF NOT EXISTS esign_provider VARCHAR(50),
            ADD COLUMN IF NOT EXISTS esign_error_code VARCHAR(50),
            ADD COLUMN IF NOT EXISTS esign_error_message TEXT,
            ADD COLUMN IF NOT EXISTS signer_aadhaar_masked VARCHAR(20),
            ADD COLUMN IF NOT EXISTS rejected_by UUID,
            ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS rejection_reason VARCHAR(255),
            ADD COLUMN IF NOT EXISTS reviewer_notes TEXT,
            ADD COLUMN IF NOT EXISTS consent_attempt_count INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS esign_retry_count INTEGER DEFAULT 0
        `);
        console.log('  Done.');

        console.log('Adding columns to kyc_documents...');
        await db.execute(sql`
            ALTER TABLE kyc_documents
            ADD COLUMN IF NOT EXISTS file_type VARCHAR(50),
            ADD COLUMN IF NOT EXISTS doc_status VARCHAR(30) DEFAULT 'not_uploaded',
            ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
            ADD COLUMN IF NOT EXISTS uploaded_by UUID,
            ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS verified_by UUID
        `);
        console.log('  Done.');

        console.log('Creating indexes...');
        await db.execute(sql`CREATE INDEX IF NOT EXISTS consent_records_lead_id_idx ON consent_records (lead_id)`);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS consent_records_status_idx ON consent_records (consent_status)`);
        await db.execute(sql`CREATE INDEX IF NOT EXISTS kyc_documents_doc_status_idx ON kyc_documents (doc_status)`);
        console.log('  Done.');

        console.log('Updating existing docs...');
        await db.execute(sql`UPDATE kyc_documents SET doc_status = 'uploaded' WHERE file_url IS NOT NULL AND doc_status = 'not_uploaded'`);
        console.log('  Done.');

        console.log('Migration complete!');
    } catch (err) {
        console.error('Migration error:', err);
    } finally {
        await pool.end();
    }
}

migrate();
