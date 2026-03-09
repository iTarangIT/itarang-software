
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
        autoRefreshToken: false,
        persistSession: false
    }
});

const UPDATES = [
    { email: 'ceo@itarang.com', password: 'NewCEOPassword123!' },
    { email: 'sales.head@itarang.com', password: 'NewSalesHeadPass123!' },
    { email: 'dealer@itarang.com', password: 'NewDealerPass123!' }
];

async function updatePasswords() {
    console.log('🚀 Starting secure password update for CEO, Sales Head, and Dealer Portal...');

    for (const update of UPDATES) {
        console.log(`\n🔍 Processing: ${update.email}...`);

        // 1. Find the user ID in Auth
        const { data: { users }, error: listError } = await supabase.auth.admin.listUsers();
        if (listError) {
            console.error(`❌ Error listing users: ${listError.message}`);
            continue;
        }

        const user = users.find(u => u.email === update.email);
        if (!user) {
            console.warn(`⚠️ User with email ${update.email} not found in Supabase Auth. Skipping.`);
            continue;
        }

        // 2. Update the password via Admin API
        // Note: Supabase securely hashes the password automatically using Argon2 or BCrypt depending on the version.
        const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
            password: update.password
        });

        if (updateError) {
            console.error(`❌ Failed to update password for ${update.email}: ${updateError.message}`);
        } else {
            console.log(`✅ Successfully updated password for ${update.email}.`);

            // 3. Verification Test (Optional but recommended by user)
            console.log(`🧪 Verifying login for ${update.email}...`);
            const { error: loginError } = await supabase.auth.signInWithPassword({
                email: update.email,
                password: update.password
            });

            if (loginError) {
                console.error(`❌ Login verification FAILED for ${update.email}: ${loginError.message}`);
            } else {
                console.log(`✨ Login verification PASSED for ${update.email}.`);
            }
        }
    }

    console.log('\n🏁 Password update process completed.');
    process.exit(0);
}

updatePasswords();
