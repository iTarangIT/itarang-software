const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function addLead() {
    const { data: userData } = await supabase.from('users').select('id').eq('email', 'ceo@itarang.com').single();

    const leadId = `LEAD-INIT-${Date.now()}`;

    console.log('Adding an initial lead...');
    const { error } = await supabase.from('leads').insert({
        id: leadId,
        lead_source: 'digital_marketing',
        owner_name: 'Sanchit Gupta',
        owner_contact: '+919876543210',
        state: 'Uttar Pradesh',
        city: 'Noida',
        interest_level: 'hot',
        lead_status: 'new',
        business_name: 'iTarang Global',
        uploader_id: userData.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
    });

    if (error) {
        console.error('Error adding lead:', error.message);
    } else {
        console.log('✓ Initial lead added successfully.');
    }
}

addLead();
