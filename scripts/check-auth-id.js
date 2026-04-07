const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
    const { data: { users }, error } = await supabase.auth.admin.listUsers();
    const user = users.find(u => u.email === 'ceo@itarang.com');
    console.log('Auth User ID:', user?.id);
}
run();
