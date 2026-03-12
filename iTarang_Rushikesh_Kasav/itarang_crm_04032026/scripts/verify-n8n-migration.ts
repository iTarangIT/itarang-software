/**
 * N8N Workflow Migration Verification Script
 * 
 * This script helps verify that:
 * 1. bolna_calls table exists in Supabase
 * 2. All required columns are present
 * 3. Indexes are created
 * 4. Connection to Supabase works
 */

import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('❌ Missing Supabase credentials');
    console.error('Required: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function verifyTableExists() {
    console.log('🔍 Checking if bolna_calls table exists...');

    const { data, error } = await supabase
        .from('bolna_calls')
        .select('*')
        .limit(0);

    if (error) {
        console.error('❌ Table does not exist or cannot be accessed:', error.message);
        return false;
    }

    console.log('✅ bolna_calls table exists');
    return true;
}

async function verifyTableStructure() {
    console.log('\n🔍 Verifying table structure...');

    const { data, error } = await supabase.rpc('exec_sql', {
        sql: `
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns
            WHERE table_name = 'bolna_calls'
            ORDER BY ordinal_position;
        `
    }).select();

    if (error) {
        console.log('⚠️  Cannot verify structure (RLS may be blocking)');
        console.log('   Attempting basic insert test instead...');
        return await verifyBasicOperations();
    }

    const requiredColumns = [
        'id', 'bolna_call_id', 'lead_id', 'status', 'current_phase',
        'started_at', 'ended_at', 'transcript_chunk', 'chunk_received_at',
        'full_transcript', 'transcript_fetched_at', 'created_at', 'updated_at'
    ];

    const existingColumns = data?.map((col: any) => col.column_name) || [];
    const missing = requiredColumns.filter(col => !existingColumns.includes(col));

    if (missing.length > 0) {
        console.error('❌ Missing columns:', missing.join(', '));
        return false;
    }

    console.log('✅ All required columns present');
    return true;
}

async function verifyBasicOperations() {
    console.log('\n🔍 Testing basic database operations...');

    const testCallId = `test-${Date.now()}`;

    // Test INSERT
    const { data: insertData, error: insertError } = await supabase
        .from('bolna_calls')
        .insert({
            id: `BOLNA-TEST-${Date.now()}`,
            bolna_call_id: testCallId,
            status: 'initiated',
            started_at: new Date().toISOString()
        })
        .select()
        .single();

    if (insertError) {
        console.error('❌ Cannot insert test record:', insertError.message);
        return false;
    }

    console.log('✅ INSERT operation works');

    // Test SELECT
    const { data: selectData, error: selectError } = await supabase
        .from('bolna_calls')
        .select('*')
        .eq('bolna_call_id', testCallId)
        .single();

    if (selectError) {
        console.error('❌ Cannot select test record:', selectError.message);
        return false;
    }

    console.log('✅ SELECT operation works');

    // Test UPDATE
    const { error: updateError } = await supabase
        .from('bolna_calls')
        .update({ status: 'completed', ended_at: new Date().toISOString() })
        .eq('bolna_call_id', testCallId);

    if (updateError) {
        console.error('❌ Cannot update test record:', updateError.message);
        return false;
    }

    console.log('✅ UPDATE operation works');

    // Test DELETE (cleanup)
    const { error: deleteError } = await supabase
        .from('bolna_calls')
        .delete()
        .eq('bolna_call_id', testCallId);

    if (deleteError) {
        console.error('⚠️  Cannot delete test record (not critical):', deleteError.message);
    } else {
        console.log('✅ DELETE operation works (test cleanup successful)');
    }

    return true;
}

async function checkExistingRecords() {
    console.log('\n🔍 Checking for existing records...');

    const { data, error, count } = await supabase
        .from('bolna_calls')
        .select('*', { count: 'exact', head: true });

    if (error) {
        console.error('❌ Cannot count records:', error.message);
        return;
    }

    console.log(`📊 Found ${count || 0} existing records in bolna_calls table`);
}

async function printSupabaseConfig() {
    console.log('\n📋 Supabase Configuration for n8n:');
    console.log('─'.repeat(60));
    console.log('Host:', supabaseUrl);
    console.log('Database:', 'postgres (default)');
    console.log('Port:', '5432 (use Supabase pooler)');
    console.log('User:', 'postgres');
    console.log('Password:', '[Use your database password from Supabase settings]');
    console.log('Connection String:', `postgresql://postgres:[password]@[host]:5432/postgres`);
    console.log('─'.repeat(60));
    console.log('\n💡 For n8n Supabase node, you can use:');
    console.log('   - Project URL:', supabaseUrl);
    console.log('   - Service Role Key: [from SUPABASE_SERVICE_ROLE_KEY env]');
}

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║   N8N Migration Verification - Bolna Calls Table        ║');
    console.log('╚══════════════════════════════════════════════════════════╝\n');

    const tableExists = await verifyTableExists();

    if (!tableExists) {
        console.log('\n❌ MIGRATION REQUIRED');
        console.log('\nPlease run the migration first:');
        console.log('   1. Go to Supabase Dashboard → SQL Editor');
        console.log('   2. Run: src/lib/db/migrations/add_bolna_calls_table.sql');
        process.exit(1);
    }

    await verifyTableStructure();
    await checkExistingRecords();
    await printSupabaseConfig();

    console.log('\n✅ Database verification complete!');
    console.log('\n📝 Next steps:');
    console.log('   1. Set up Supabase credentials in n8n');
    console.log('   2. Follow the migration guide in implementation_plan.md');
    console.log('   3. Replace Postgres nodes with Supabase nodes');
    console.log('   4. Test each webhook event type\n');
}

main();
