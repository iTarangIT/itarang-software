const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function checkLeads() {
    const { data, error } = await supabase.from('leads').select('*');
    if (error) {
        console.error('Error:', error.message);
        return;
    }
    console.log('Leads found:', data.length);
    if (data.length > 0) {
        console.log('First lead:', data[0].business_name);
    }
}

checkLeads();
