const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
    const { data } = await supabase.from('users').select('*').eq('email', 'ceo@itarang.com').single();
    console.log('User Data:', JSON.stringify(data, null, 2));
}
run();
